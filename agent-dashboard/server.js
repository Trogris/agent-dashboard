require('dotenv').config();

const express = require('express');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');
const { TOOL_DEFINITIONS, executeTool } = require('./tools');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const COMMANDS_DIR = path.join(__dirname, 'agents');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');
const MEMORY_DIR = path.join(__dirname, 'agents', 'memory');

if (!process.env.VERCEL && !fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR);
if (!process.env.VERCEL && !fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });

function extractActivationNotice(content) {
  const idx = content.indexOf('ACTIVATION-NOTICE:');
  if (idx === -1) return null;
  return content.slice(idx + 'ACTIVATION-NOTICE:'.length).trim();
}

function extractTitle(content) {
  const match = content.match(/title:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function extractGreeting(content) {
  // Only look before the first ```yaml block — greetings inside YAML are in English and ignored
  const yamlIdx = content.indexOf('```yaml');
  const searchIn = yamlIdx > -1 ? content.slice(0, yamlIdx) : content;
  const match = searchIn.match(/greeting:\s*"([^"]+)"/s);
  return match ? match[1].replace(/\\n/g, '\n').trim() : null;
}

// ── Memory helpers ──
function getMemoryPath(agentId) {
  const safeName = agentId.replace(/\//g, '__');
  return path.join(MEMORY_DIR, `${safeName}.md`);
}

function getMemoryContent(agentId) {
  if (!agentId) return null;
  const memPath = getMemoryPath(agentId);
  if (!fs.existsSync(memPath)) return null;
  const content = fs.readFileSync(memPath, 'utf-8').trim();
  return content || null;
}

const WEB_SUFFIX = `

---
GERACAO DE ARQUIVOS — INSTRUCAO OBRIGATORIA:
Quando o usuario pedir planilha, relatorio PDF ou apresentacao, inclua na sua resposta um bloco com os dados estruturados no formato abaixo. Este bloco nao aparece para o usuario — o sistema detecta e gera o arquivo automaticamente.

\`\`\`file-data
{
  "type": "xlsx",
  "filename": "nome_do_arquivo",
  "title": "Titulo",
  "sheets": [
    {
      "name": "Nome da aba",
      "rows": [
        ["Coluna 1", "Coluna 2"],
        ["dado1", "dado2"]
      ]
    }
  ]
}
\`\`\`

Para PDF use "type": "pdf" com "sections": [{"title": "...", "text": "..."}] ou "bullets": ["..."] ou "table": [[...]]
Para PowerPoint use "type": "pptx" com "slides": [{"title": "...", "bullets": ["...", "..."]}]
Preencha sempre com dados reais e relevantes baseados na conversa.`;

function buildSystemPrompt(systemPrompt, agentId) {
  const memory = getMemoryContent(agentId);
  const base = memory
    ? `${systemPrompt}\n\n---\nMEMORIA PERSISTENTE — CONTEXTO ACUMULADO:\n${memory}`
    : systemPrompt;
  return base + WEB_SUFFIX;
}

function extractRole(content) {
  const match = content.match(/^role:\s*(\w+)/m);
  return match ? match[1] : 'specialist';
}

function extractDelegates(content) {
  const match = content.match(/^delegates:\s*(.+)/m);
  if (!match) return [];
  return match[1].split(',').map(s => s.trim()).filter(Boolean);
}

function getAgents() {
  const agents = [];
  function scanDir(dir, squad) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath, entry.name);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const agentId = entry.name.replace('.md', '');
        const heading = content.match(/^#\s+(.+)/m);
        const name = heading ? heading[1].trim() : agentId;
        const title = extractTitle(content) || '';
        const activation = extractActivationNotice(content) || content.substring(0, 500);
        const greeting = extractGreeting(content) || `Olá! Sou ${name}${title ? ` — ${title}` : ''}. Como posso ajudar?`;
        const role = extractRole(content);
        const delegates = extractDelegates(content);
        agents.push({
          id: squad ? `${squad}/${agentId}` : agentId,
          agentId, squad: squad || 'geral',
          name, title, systemPrompt: activation, greeting, role, delegates
        });
      }
    }
  }
  scanDir(COMMANDS_DIR, null);
  return agents;
}

// ── Config ──
app.get('/api/config', (req, res) => {
  const hasKey = !!process.env.OPENAI_API_KEY &&
    process.env.OPENAI_API_KEY !== 'cole_sua_chave_aqui' &&
    process.env.OPENAI_API_KEY !== 'cole_sua_nova_chave_aqui';
  res.json({ hasServerKey: hasKey });
});

// ── Agents ──
app.get('/api/agents', (req, res) => {
  try { res.json(getAgents()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Chat ──
app.post('/api/chat', async (req, res) => {
  const { messages, systemPrompt, apiKey, model, agentId } = req.body;
  const key = (process.env.OPENAI_API_KEY &&
    !['cole_sua_chave_aqui','cole_sua_nova_chave_aqui'].includes(process.env.OPENAI_API_KEY))
    ? process.env.OPENAI_API_KEY : apiKey;

  if (!key) return res.status(400).json({ error: 'Chave da API não configurada.' });

  const openai = new OpenAI({ apiKey: key });
  const selectedModel = model || 'gpt-5.4-mini';
  const finalSystemPrompt = buildSystemPrompt(systemPrompt, agentId);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    // Primeira chamada: streaming com deteccao de tool_calls
    const firstStream = await openai.chat.completions.create({
      model: selectedModel,
      messages: [{ role: 'system', content: finalSystemPrompt }, ...messages],
      tools: TOOL_DEFINITIONS,
      tool_choice: 'auto',
      stream: true
    });

    // Acumula tool_calls e conteudo do stream simultaneamente
    const pendingCalls = {};  // { index: { id, name, args } }
    let contentBuffer = '';
    let finishReason = null;

    for await (const chunk of firstStream) {
      const delta = chunk.choices[0]?.delta;
      const reason = chunk.choices[0]?.finish_reason;
      if (reason) finishReason = reason;

      if (delta?.content) {
        contentBuffer += delta.content;
        emit({ content: delta.content });
      }

      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!pendingCalls[tc.index]) {
            pendingCalls[tc.index] = { id: tc.id || '', name: '', args: '' };
          }
          if (tc.id) pendingCalls[tc.index].id = tc.id;
          if (tc.function?.name) pendingCalls[tc.index].name += tc.function.name;
          if (tc.function?.arguments) pendingCalls[tc.index].args += tc.function.arguments;
        }
      }
    }

    // Se houve tool_calls, executa e sintetiza
    if (finishReason === 'tool_calls' && Object.keys(pendingCalls).length > 0) {
      const toolCalls = Object.values(pendingCalls);

      // Monta mensagem do assistente com tool_calls
      const assistantMsg = {
        role: 'assistant',
        content: contentBuffer || null,
        tool_calls: toolCalls.map(tc => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args }
        }))
      };

      const toolResults = [];
      for (const tc of toolCalls) {
        let parsedArgs;
        try { parsedArgs = JSON.parse(tc.args); } catch { parsedArgs = {}; }

        // Avisa o frontend que uma ferramenta esta sendo usada
        emit({ type: 'tool_use', tool: tc.name, args: parsedArgs });

        let result;
        try { result = await executeTool(tc.name, parsedArgs); }
        catch (err) { result = `Erro ao executar ${tc.name}: ${err.message}`; }

        toolResults.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
      }

      // Sintese final — streaming
      const synthStream = await openai.chat.completions.create({
        model: selectedModel,
        messages: [
          { role: 'system', content: finalSystemPrompt },
          ...messages,
          assistantMsg,
          ...toolResults
        ],
        stream: true
      });

      for await (const chunk of synthStream) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) emit({ content });
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    emit({ type: 'error', error: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ── Orchestrate (multi-agent) ──
app.post('/api/orchestrate', async (req, res) => {
  const { messages, agentId, apiKey: clientKey } = req.body;
  const key = (process.env.OPENAI_API_KEY &&
    !['cole_sua_chave_aqui','cole_sua_nova_chave_aqui'].includes(process.env.OPENAI_API_KEY))
    ? process.env.OPENAI_API_KEY : clientKey;

  if (!key) return res.status(400).json({ error: 'Chave da API não configurada.' });

  const agents = getAgents();
  const orchestrator = agents.find(a => a.id === agentId || a.agentId === agentId);
  if (!orchestrator) return res.status(404).json({ error: 'Agente orquestrador não encontrado.' });
  if (!orchestrator.delegates || orchestrator.delegates.length === 0) {
    return res.status(400).json({ error: 'Este agente não possui especialistas configurados.' });
  }

  // Build delegate agent list and OpenAI tools
  const delegateAgents = orchestrator.delegates
    .map(id => agents.find(a => a.agentId === id))
    .filter(Boolean);

  const tools = delegateAgents.map(agent => ({
    type: 'function',
    function: {
      name: agent.agentId,
      description: `${agent.name} — ${agent.title}. ${agent.systemPrompt.slice(0, 300)}`.slice(0, 1000),
      parameters: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'Tarefa, pergunta ou análise para este especialista executar' }
        },
        required: ['task']
      }
    }
  }));

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const openai = new OpenAI({ apiKey: key });
  const emit = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  // Instrucao de orquestracao injetada no system prompt
  const delegateNames = delegateAgents.map(a => `- ${a.agentId}: ${a.name} (${a.title})`).join('\n');
  const orchestrationInstruction = `

---
INSTRUCAO DE ORQUESTRACAO — REGRA ABSOLUTA:
Voce e um orquestrador. Voce NAO responde diretamente perguntas que sejam de responsabilidade dos seus especialistas.
Voce tem os seguintes especialistas disponiveis como ferramentas:
${delegateNames}

REGRAS:
1. Sempre que a pergunta tocar a area de um especialista, use a ferramenta correspondente — mesmo sem contexto completo. O especialista vai pedir mais informacoes se precisar.
2. Voce pode acionar MULTIPLOS especialistas ao mesmo tempo em chamadas paralelas.
3. Voce so responde diretamente quando a pergunta for sobre visao geral, estrategia corporativa ou algo que genuinamente nao pertence a nenhum especialista.
4. Apos receber as respostas dos especialistas, voce sintetiza uma visao executiva integrada.
5. NUNCA peca informacoes antes de consultar os especialistas — deixe isso para eles.`;

  const orchestratorPrompt = buildSystemPrompt(orchestrator.systemPrompt, orchestrator.id) + orchestrationInstruction;

  try {
    // Detecta se a mensagem envolve area de algum especialista
    // Se a pergunta menciona explicitamente uma area, forca delegacao
    const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')?.content?.toLowerCase() || '';
    const delegateKeywords = delegateAgents.flatMap(a => [a.agentId, a.name.toLowerCase(), a.title?.toLowerCase() || '']);
    const forceDelegate = delegateKeywords.some(kw => kw && lastUserMsg.includes(kw.toLowerCase()));

    // First call: orchestrator decides whether to delegate
    const firstResp = await openai.chat.completions.create({
      model: 'gpt-5.4',
      messages: [{ role: 'system', content: orchestratorPrompt }, ...messages],
      tools,
      tool_choice: forceDelegate ? 'required' : 'auto'
    });

    const firstMsg = firstResp.choices[0].message;

    if (firstMsg.tool_calls && firstMsg.tool_calls.length > 0) {
      const toolResults = [];

      for (const toolCall of firstMsg.tool_calls) {
        const delegateId = toolCall.function.name;
        const delegateAgent = delegateAgents.find(a => a.agentId === delegateId);
        if (!delegateAgent) continue;

        emit({ type: 'delegation', agentName: delegateAgent.name });

        let args;
        try { args = JSON.parse(toolCall.function.arguments); } catch { args = { task: toolCall.function.arguments }; }
        const task = args.task || JSON.stringify(args);

        // Check if delegate is itself an orchestrator (2nd-level)
        const isSubOrch = delegateAgent.role === 'orchestrator' && delegateAgent.delegates && delegateAgent.delegates.length > 0;
        let subResponse = '';

        if (isSubOrch) {
          const subDelegates = delegateAgent.delegates
            .map(id => agents.find(a => a.agentId === id))
            .filter(Boolean);

          const subTools = subDelegates.map(a => ({
            type: 'function',
            function: {
              name: a.agentId,
              description: `${a.name} — ${a.title}. ${a.systemPrompt.slice(0, 200)}`.slice(0, 800),
              parameters: {
                type: 'object',
                properties: { task: { type: 'string', description: 'Tarefa para este especialista' } },
                required: ['task']
              }
            }
          }));

          const subFirst = await openai.chat.completions.create({
            model: 'gpt-5.4',
            messages: [
              { role: 'system', content: delegateAgent.systemPrompt },
              { role: 'user', content: task }
            ],
            tools: subTools.length > 0 ? subTools : undefined,
            tool_choice: subTools.length > 0 ? 'auto' : undefined
          });

          const subFirstMsg = subFirst.choices[0].message;

          if (subFirstMsg.tool_calls && subFirstMsg.tool_calls.length > 0) {
            const subToolResults = [];
            for (const subTC of subFirstMsg.tool_calls) {
              const subDelegate = subDelegates.find(a => a.agentId === subTC.function.name);
              if (!subDelegate) continue;
              emit({ type: 'delegation', agentName: subDelegate.name });
              let subArgs;
              try { subArgs = JSON.parse(subTC.function.arguments); } catch { subArgs = { task: subTC.function.arguments }; }
              const subTask = subArgs.task || JSON.stringify(subArgs);
              const subComp = await openai.chat.completions.create({
                model: 'gpt-5.4-mini',
                messages: [
                  { role: 'system', content: subDelegate.systemPrompt },
                  { role: 'user', content: subTask }
                ]
              });
              subToolResults.push({
                tool_call_id: subTC.id,
                role: 'tool',
                content: subComp.choices[0].message.content
              });
            }
            const subSynth = await openai.chat.completions.create({
              model: 'gpt-5.4',
              messages: [
                { role: 'system', content: delegateAgent.systemPrompt },
                { role: 'user', content: task },
                subFirstMsg,
                ...subToolResults
              ]
            });
            subResponse = subSynth.choices[0].message.content;
          } else {
            subResponse = subFirstMsg.content;
          }
        } else {
          // Direct specialist — single call
          const subComp = await openai.chat.completions.create({
            model: 'gpt-5.4-mini',
            messages: [
              { role: 'system', content: buildSystemPrompt(delegateAgent.systemPrompt, delegateAgent.id) },
              { role: 'user', content: task }
            ]
          });
          subResponse = subComp.choices[0].message.content;
        }

        toolResults.push({ tool_call_id: toolCall.id, role: 'tool', content: subResponse });
      }

      // Final synthesis — streamed
      emit({ type: 'synthesis' });
      const finalResp = await openai.chat.completions.create({
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: orchestratorPrompt },
          ...messages,
          firstMsg,
          ...toolResults
        ],
        stream: true
      });

      for await (const chunk of finalResp) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) emit({ type: 'content', content });
      }
    } else {
      // No delegation — orchestrator answered directly
      emit({ type: 'content', content: firstMsg.content || '' });
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    emit({ type: 'error', error: err.message });
    res.write('data: [DONE]\n\n');
    res.end();
  }
});

// ── Memory ──
app.get('/api/memory/*path', (req, res) => {
  const agentId = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
  const memory = getMemoryContent(agentId);
  res.json({ memory, hasMemory: !!memory });
});

app.delete('/api/memory/*path', (req, res) => {
  const agentId = Array.isArray(req.params.path) ? req.params.path.join('/') : req.params.path;
  const memPath = getMemoryPath(agentId);
  if (fs.existsSync(memPath)) fs.unlinkSync(memPath);
  res.json({ success: true });
});

app.post('/api/memory/consolidate', async (req, res) => {
  const { messages, agentId, agentName, apiKey: clientKey } = req.body;
  const key = (process.env.OPENAI_API_KEY &&
    !['cole_sua_chave_aqui','cole_sua_nova_chave_aqui'].includes(process.env.OPENAI_API_KEY))
    ? process.env.OPENAI_API_KEY : clientKey;

  if (!key) return res.status(400).json({ error: 'Chave da API não configurada.' });
  if (!messages || messages.length === 0) return res.status(400).json({ error: 'Sem mensagens para consolidar.' });

  const currentMemory = getMemoryContent(agentId) || '';
  const today = new Date().toLocaleDateString('pt-BR');

  const conversationText = messages
    .map(m => `${m.role === 'user' ? 'Usuario' : agentName}: ${m.content.slice(0, 800)}`)
    .join('\n\n');

  const prompt = `Voce e um sistema de consolidacao de memoria para agentes de IA. Com base na conversa abaixo, atualize a memoria persistente do agente "${agentName}".

MEMORIA ATUAL:
${currentMemory || '(sem memoria previa)'}

CONVERSA RECENTE:
${conversationText}

Gere uma memoria atualizada no seguinte formato Markdown. Mantenha o que ainda e relevante da memoria atual e adicione o que e novo e importante da conversa recente. Seja conciso e acionavel.

# Memoria — ${agentName}
Ultima atualizacao: ${today}

## Contexto do Usuario e Negocio
(fatos relevantes sobre o usuario, empresa, setor, situacao atual)

## Decisoes e Acordos Firmados
(decisoes tomadas nas conversas — o que foi definido, acordado ou escolhido)

## Projetos e Iniciativas em Andamento
(o que esta sendo trabalhado, estagio atual)

## Licoes e Aprendizados
(insights relevantes, erros identificados, melhores praticas descobertas)

## Proximos Passos
(acoes pendentes com responsavel e prazo quando disponivel)

Retorne APENAS o conteudo Markdown da memoria atualizada, sem explicacoes adicionais.`;

  try {
    const openai = new OpenAI({ apiKey: key });
    const completion = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: prompt }]
    });

    const newMemory = completion.choices[0].message.content.trim();

    if (!process.env.VERCEL) {
      fs.writeFileSync(getMemoryPath(agentId), newMemory, 'utf-8');
    }

    res.json({ success: true, memory: newMemory });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Executor Python ──
app.post('/api/execute', (req, res) => {
  if (process.env.VERCEL) {
    return res.status(400).json({ error: 'Execução local não disponível na versão online.' });
  }
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Código não informado.' });

  const fileId = crypto.randomBytes(8).toString('hex');
  const scriptPath = path.join(OUTPUTS_DIR, `script_${fileId}.py`);

  // Injeta o diretório de saída no código
  const wrappedCode = `
import os, sys
OUTPUT_DIR = r"${OUTPUTS_DIR}"
os.makedirs(OUTPUT_DIR, exist_ok=True)

${code}
`;

  fs.writeFileSync(scriptPath, wrappedCode);

  exec(`python3 "${scriptPath}"`, { timeout: 30000 }, (err, stdout, stderr) => {
    fs.unlinkSync(scriptPath);

    if (err) {
      return res.status(500).json({ error: stderr || err.message });
    }

    // Detecta arquivos gerados na pasta outputs
    const files = fs.readdirSync(OUTPUTS_DIR)
      .filter(f => !f.startsWith('script_'))
      .map(f => ({
        name: f,
        url: `/api/download/${f}`,
        size: fs.statSync(path.join(OUTPUTS_DIR, f)).size
      }));

    res.json({ success: true, stdout, files });
  });
});

// ── Download ──
app.get('/api/download/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(OUTPUTS_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }

  res.download(filePath, filename);
});

// ── Listar arquivos gerados ──
app.get('/api/files', (req, res) => {
  const files = fs.readdirSync(OUTPUTS_DIR)
    .filter(f => !f.startsWith('script_'))
    .map(f => ({
      name: f,
      url: `/api/download/${f}`,
      size: fs.statSync(path.join(OUTPUTS_DIR, f)).size,
      created: fs.statSync(path.join(OUTPUTS_DIR, f)).birthtime
    }))
    .sort((a, b) => new Date(b.created) - new Date(a.created));

  res.json(files);
});

// Streaming sem buffer no Vercel
app.use((req, res, next) => {
  res.setHeader('X-Accel-Buffering', 'no');
  next();
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Agent Dashboard rodando em http://localhost:${PORT}`);
    if (process.env.TELEGRAM_BOT_TOKEN) {
      try { require('./telegram')(); }
      catch (e) { console.error('Erro ao iniciar Telegram bot:', e.message); }
    }
  });
}

module.exports = app;
