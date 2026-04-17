require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');
const pdfParse = require('pdf-parse');
const XLSX = require('xlsx');
const officeParser = require('officeparser');
const { runWithTools } = require('./tools');
const { extractFileData, cleanText: cleanFileData, generateFile, deleteFile } = require('./file-generator');

const COMMANDS_DIR = path.join(__dirname, 'agents');
const MEMORY_DIR = path.join(__dirname, 'agents', 'memory');

// Instrucoes especificas para o contexto Telegram
const TELEGRAM_SUFFIX = `

---
INSTRUCOES PARA ESTA CONVERSA (Telegram):
Tom e postura:
- Seja acolhedor, empático e humano — como um conselheiro de confiança, nao um sistema
- Use linguagem simples e proxima, como se estivesse conversando pessoalmente
- Demonstre genuino interesse pelo que o usuario trouxe antes de responder
- Quando appropriate, valide o contexto do usuario antes de ir direto ao ponto
- Evite jargao tecnico desnecessario — se usar um termo, explique em seguida de forma natural
- Pode usar expressoes como "faz sentido", "entendo", "boa pergunta" para criar rapport

Formato:
- Maximo 3 paragrafos curtos por mensagem
- Texto corrido — sem listas longas, sem bullet points, sem asteriscos, sem hashtags
- Termine com uma pergunta ou convite para continuar quando fizer sentido

Opcoes interativas:
- Quando fizer sentido oferecer caminhos distintos, termine a mensagem com esta linha exata:
OPCOES: Opcao A | Opcao B | Opcao C
- Use OPCOES apenas quando houver 2 a 4 caminhos realmente distintos

Geracao de arquivos:
- Quando o usuario pedir planilha, apresentacao ou relatorio PDF, inclua na sua resposta um bloco com os dados estruturados assim:
\`\`\`file-data
{
  "type": "xlsx",
  "filename": "nome_do_arquivo",
  "title": "Titulo do arquivo",
  "sheets": [
    {
      "name": "Nome da aba",
      "rows": [
        ["Coluna 1", "Coluna 2", "Coluna 3"],
        ["dado1", "dado2", "dado3"]
      ]
    }
  ]
}
\`\`\`
- Para PDF use "type": "pdf" com "sections": [{"title": "...", "text": "..." }] ou "bullets" ou "table"
- O bloco file-data nao aparece para o usuario — so o arquivo gerado e enviado
- Preencha os dados com informacao real e relevante baseada na conversa`;

// ── Mapa de vozes por squad ──
// Femininas: nova (quente, proxima), shimmer (clara, formal)
// Masculinas: onyx (grave, autoritario), echo (equilibrado), fable (narrativo), alloy (neutro tecnico)
const SQUAD_VOICES = {
  'geral':               'shimmer', // Controladoria/Financas — mulher, formal
  'industrial':          'shimmer', // Industrial tem RH/pessoas — mulher
  'c-level-squad':       'onyx',    // C-Level — grave, autoritario
  'advisory-board':      'onyx',    // Advisory — experiente, peso
  'hormozi-squad':       'onyx',    // Hormozi — direto, forcoso
  'copy-master':         'fable',   // Copy — expressivo, narrativo
  'copy-squad':          'fable',   // Copy — idem
  'storytelling':        'fable',   // Storytelling — narrativo por excelencia
  'brand-squad':         'nova',    // Brand — quente, criativo
  'traffic-masters':     'echo',    // Traffic — equilibrado, analitico
  'data-squad':          'alloy',   // Data — neutro, tecnico
  'design-squad':        'nova',    // Design — criativo, proximo
  'cybersecurity':       'echo',    // Cyber — seco, preciso
  'claude-code-mastery': 'alloy',   // Tech — neutro, tecnico
  'movement':            'shimmer', // Movement — clara, inspiradora
  'problem-solver-squad':'echo',    // Problem solver — equilibrado
};

// Agentes especificos que tem RH/Pessoas sobrepoe o squad
const AGENT_VOICES = {
  'industrial-chief': 'nova', // se tiver agente de RH industrial
};

function getAgentVoice(agent) {
  return AGENT_VOICES[agent.agentId] || SQUAD_VOICES[agent.squad] || 'alloy';
}

// ── Helpers (espelho do server.js) ──
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
  const yamlIdx = content.indexOf('```yaml');
  const searchIn = yamlIdx > -1 ? content.slice(0, yamlIdx) : content;
  const match = searchIn.match(/greeting:\s*"([^"]+)"/s);
  return match ? match[1].replace(/\\n/g, '\n').trim() : null;
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
function getMemoryPath(agentId) {
  return path.join(MEMORY_DIR, agentId.replace(/\//g, '__') + '.md');
}
function getMemoryContent(agentId) {
  if (!agentId) return null;
  const p = getMemoryPath(agentId);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf-8').trim() || null;
}
function buildSystemPrompt(systemPrompt, agentId) {
  const memory = getMemoryContent(agentId);
  const base = memory
    ? `${systemPrompt}\n\n---\nMEMORIA PERSISTENTE — CONTEXTO ACUMULADO:\n${memory}`
    : systemPrompt;
  return base + TELEGRAM_SUFFIX;
}
function getAgents() {
  const agents = [];
  function scan(dir, squad) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full, entry.name);
      else if (entry.isFile() && entry.name.endsWith('.md')) {
        const content = fs.readFileSync(full, 'utf-8');
        const agentId = entry.name.replace('.md', '');
        const name = (content.match(/^#\s+(.+)/m) || [])[1]?.trim() || agentId;
        const title = extractTitle(content) || '';
        const activation = extractActivationNotice(content) || content.slice(0, 500);
        const greeting = extractGreeting(content) || `Ola! Sou ${name}${title ? ` — ${title}` : ''}. Como posso ajudar?`;
        agents.push({
          id: squad ? `${squad}/${agentId}` : agentId,
          agentId, squad: squad || 'geral',
          name, title, systemPrompt: activation, greeting,
          role: extractRole(content),
          delegates: extractDelegates(content)
        });
      }
    }
  }
  scan(COMMANDS_DIR, null);
  return agents;
}

// ── Memoria auto-save ──
async function autoSaveMemory(agent, messages, openai) {
  if (!agent || messages.length < 4) return;
  const today = new Date().toLocaleDateString('pt-BR');
  const currentMemory = getMemoryContent(agent.id) || '';
  const conv = messages.map(m => `${m.role === 'user' ? 'Usuario' : agent.name}: ${m.content.slice(0, 800)}`).join('\n\n');
  const prompt = `Voce e um sistema de consolidacao de memoria. Atualize a memoria do agente "${agent.name}".

MEMORIA ATUAL:
${currentMemory || '(sem memoria previa)'}

CONVERSA RECENTE:
${conv}

Gere uma memoria atualizada no formato abaixo. Seja conciso e acionavel.

# Memoria — ${agent.name}
Ultima atualizacao: ${today}

## Contexto do Usuario e Negocio
## Decisoes e Acordos Firmados
## Projetos e Iniciativas em Andamento
## Licoes e Aprendizados
## Proximos Passos

Retorne APENAS o Markdown, sem explicacoes.`;
  try {
    const r = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [{ role: 'user', content: prompt }]
    });
    fs.writeFileSync(getMemoryPath(agent.id), r.choices[0].message.content.trim(), 'utf-8');
  } catch {}
}

// ── Orquestracao (nao-streaming) ──
async function callOrchestrator(orchestrator, messages, agents, openai) {
  const delegates = orchestrator.delegates.map(id => agents.find(a => a.agentId === id)).filter(Boolean);
  const tools = delegates.map(a => ({
    type: 'function',
    function: {
      name: a.agentId,
      description: `${a.name} — ${a.title}. ${a.systemPrompt.slice(0, 300)}`.slice(0, 1000),
      parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] }
    }
  }));
  const delegateNames = delegates.map(a => `- ${a.agentId}: ${a.name} (${a.title})`).join('\n');
  const orchestrationInstruction = `\n\n---\nINSTRUCAO DE ORQUESTRACAO — REGRA ABSOLUTA:\nVoce e um orquestrador. Voce NAO responde diretamente perguntas que sejam de responsabilidade dos seus especialistas.\nVoce tem os seguintes especialistas disponiveis como ferramentas:\n${delegateNames}\n\nREGRAS:\n1. Sempre que a pergunta tocar a area de um especialista, use a ferramenta correspondente — mesmo sem contexto completo.\n2. Voce pode acionar MULTIPLOS especialistas ao mesmo tempo em chamadas paralelas.\n3. Voce so responde diretamente quando a pergunta for sobre visao geral ou estrategia corporativa.\n4. Apos receber as respostas, sintetize uma visao executiva integrada.\n5. NUNCA peca informacoes antes de consultar os especialistas.`;
  const sp = buildSystemPrompt(orchestrator.systemPrompt, orchestrator.id) + orchestrationInstruction;
  const first = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [{ role: 'system', content: sp }, ...messages],
    tools, tool_choice: 'auto'
  });
  const firstMsg = first.choices[0].message;
  if (!firstMsg.tool_calls?.length) return firstMsg.content;

  const results = [];
  for (const tc of firstMsg.tool_calls) {
    const delegate = delegates.find(a => a.agentId === tc.function.name);
    if (!delegate) continue;
    let args; try { args = JSON.parse(tc.function.arguments); } catch { args = { task: tc.function.arguments }; }
    const sub = await openai.chat.completions.create({
      model: 'gpt-5.4-mini',
      messages: [
        { role: 'system', content: buildSystemPrompt(delegate.systemPrompt, delegate.id) },
        { role: 'user', content: args.task || JSON.stringify(args) }
      ]
    });
    results.push({ tool_call_id: tc.id, role: 'tool', content: sub.choices[0].message.content });
  }
  const final = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [{ role: 'system', content: sp }, ...messages, firstMsg, ...results]
  });
  return final.choices[0].message.content;
}

// ── Formatacao e envio humanizado ──
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseOptions(text) {
  const match = text.match(/OPCOES:\s*(.+?)(\n|$)/i);
  if (!match) return { cleanText: text, options: [] };
  const options = match[1].split('|').map(s => s.trim()).filter(Boolean).slice(0, 5);
  const cleanText = text.replace(/OPCOES:\s*.+?(\n|$)/i, '').trim();
  return { cleanText, options };
}

function buildOptionsKeyboard(options) {
  // Cada opcao em sua propria linha para facilitar leitura
  return {
    inline_keyboard: options.map(opt => [{
      text: opt,
      callback_data: `opt:${opt.slice(0, 58)}`
    }])
  };
}

function formatText(text) {
  return text
    .replace(/^#{1,6} /gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/_(.*?)_/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function sendHumanized(bot, chatId, text) {
  const { cleanText, options } = parseOptions(text);
  const formatted = formatText(cleanText);

  // Divide em paragrafos e agrupa em blocos de ate 2
  const paragraphs = formatted.split(/\n\n+/).map(p => p.trim()).filter(p => p.length > 0);
  const chunks = [];
  for (let i = 0; i < paragraphs.length; i += 2) {
    const chunk = paragraphs.slice(i, i + 2).join('\n\n');
    if (chunk.trim()) chunks.push(chunk);
  }
  if (!chunks.length) chunks.push(formatted);

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) {
      // Simula digitacao — delay proporcional ao tamanho do bloco
      await bot.sendChatAction(chatId, 'typing');
      await sleep(Math.min(400 + chunks[i].length * 22, 3000));
    }

    const isLast = i === chunks.length - 1;
    if (isLast && options.length > 0) {
      await bot.sendMessage(chatId, chunks[i], { reply_markup: buildOptionsKeyboard(options) });
    } else {
      await bot.sendMessage(chatId, chunks[i]);
    }
  }

  // Se so tem opcoes sem texto antes
  if (!chunks.length && options.length > 0) {
    await bot.sendMessage(chatId, 'Escolha uma opcao:', { reply_markup: buildOptionsKeyboard(options) });
  }
}

// ── Squads no menu ──
const MENU_SQUADS = [
  { key: 'c-level-squad',   label: 'C-Level'       },
  { key: 'advisory-board',  label: 'Advisory Board' },
  { key: 'industrial',      label: 'Industrial'     },
  { key: 'hormozi-squad',   label: 'Hormozi'        },
  { key: 'copy-squad',      label: 'Copywriting'    },
  { key: 'brand-squad',     label: 'Brand'          },
  { key: 'traffic-masters', label: 'Traffic'        },
  { key: 'storytelling',    label: 'Storytelling'   },
  { key: 'geral',           label: 'Financas'       },
];

function squadKeyboard() {
  const rows = [];
  for (let i = 0; i < MENU_SQUADS.length; i += 2) {
    const row = [{ text: MENU_SQUADS[i].label, callback_data: `squad:${MENU_SQUADS[i].key}` }];
    if (MENU_SQUADS[i + 1]) row.push({ text: MENU_SQUADS[i + 1].label, callback_data: `squad:${MENU_SQUADS[i + 1].key}` });
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function agentKeyboard(agents, squad) {
  const list = agents.filter(a => a.squad === squad).slice(0, 24);
  const rows = [];
  for (let i = 0; i < list.length; i += 2) {
    const row = [{ text: list[i].name, callback_data: `agent:${list[i].id}` }];
    if (list[i + 1]) row.push({ text: list[i + 1].name, callback_data: `agent:${list[i + 1].id}` });
    rows.push(row);
  }
  rows.push([{ text: 'Voltar', callback_data: 'back:squads' }]);
  return { inline_keyboard: rows };
}

// ── TTS: converte texto em audio e envia como mensagem de voz ──
async function sendVoiceReply(bot, openai, chatId, text, voice) {
  let tmpPath = null;
  try {
    const clean = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/__(.*?)__/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/_(.*?)_/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\n{2,}/g, ' ')
      .trim()
      .slice(0, 4000);

    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice || 'alloy',
      input: clean,
      response_format: 'opus',
      speed: 1.0
    });

    tmpPath = path.join(os.tmpdir(), `tg_tts_${Date.now()}.ogg`);
    const buffer = Buffer.from(await mp3.arrayBuffer());
    fs.writeFileSync(tmpPath, buffer);
    await bot.sendVoice(chatId, tmpPath);
  } catch (err) {
    console.error('Erro TTS:', err.message);
  } finally {
    if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ── Processamento de mensagem (reutilizado por texto e botoes) ──
async function processMessage(bot, chatId, text, s, agents, openai, replyWithVoice = false) {
  const agent = agents.find(a => a.id === s.agentId);
  if (!agent) return;

  s.messages.push({ role: 'user', content: text });

  bot.sendChatAction(chatId, 'typing');
  const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);

  try {
    let response = '';
    if (agent.delegates?.length > 0) {
      response = await callOrchestrator(agent, s.messages, agents, openai);
    } else {
      const model = ['c-level-squad', 'advisory-board'].includes(agent.squad) ? 'gpt-5.4' : 'gpt-5.4-mini';
      response = await runWithTools(openai, {
        model,
        systemPrompt: buildSystemPrompt(agent.systemPrompt, agent.id),
        messages: s.messages
      });
    }

    s.messages.push({ role: 'assistant', content: response });

    if (s.messages.length > (s.lastSaved || 0) + 9) {
      autoSaveMemory(agent, s.messages, openai);
      s.lastSaved = s.messages.length;
    }

    clearInterval(typingInterval);

    // Verifica se ha arquivo para gerar
    const fileData = extractFileData(response);
    const visibleText = fileData ? cleanFileData(response) : response;

    // Envia resposta — voz ou texto
    const useVoice = replyWithVoice || s.voiceMode;
    if (useVoice && visibleText && !fileData) {
      await sendVoiceReply(bot, openai, chatId, visibleText, getAgentVoice(agent));
    } else if (visibleText) {
      await sendHumanized(bot, chatId, visibleText);
    }

    // Gera e envia o arquivo
    if (fileData) {
      let filePath = null;
      try {
        await bot.sendChatAction(chatId, 'upload_document');
        filePath = await generateFile(fileData.type, fileData);
        const ext = fileData.type;
        const name = `${(fileData.filename || 'arquivo').replace(/\s+/g, '_')}.${ext}`;
        await bot.sendDocument(chatId, filePath, {}, { filename: name });
      } catch (fileErr) {
        console.error('Erro ao gerar arquivo:', fileErr.message);
        await bot.sendMessage(chatId, 'Nao consegui gerar o arquivo. Tente novamente.');
      } finally {
        if (filePath) deleteFile(filePath);
      }
    }

  } catch (err) {
    clearInterval(typingInterval);
    await bot.sendMessage(chatId, `Erro: ${err.message}`);
  }
}

// ── Saudacoes de entrada (variam a cada /start) ──
const START_GREETINGS = [
  `Oi! Que bom ter você aqui.\n\nSou seu painel de consultores — cada um com conhecimento profundo na sua área. Me diz o que está na sua cabeça e eu te conecto com a pessoa certa.`,
  `Olá! Bem-vindo.\n\nAqui você tem acesso a consultores especializados em estratégia, marketing, operações, finanças e muito mais. O que você precisa resolver hoje?`,
  `Oi, tudo bem? Fico feliz que você veio.\n\nTenho uma equipe inteira pronta para te ajudar — desde decisões estratégicas até questões do dia a dia do negócio. Por onde quer começar?`,
  `Olá! Bom te ver por aqui.\n\nIndependent do desafio — estratégia, operação, marketing, financeiro — tem um especialista aqui para te ajudar a pensar com clareza. O que está acontecendo?`,
  `Oi! Seja bem-vindo ao seu painel de consultores.\n\nNão precisa ter a pergunta perfeita — pode começar pelo que está te incomodando ou pelo que você quer melhorar. Estamos aqui.`,
];

const HANDOFF_MESSAGES = [
  name => `Conectando você com ${name}...`,
  name => `Um momento — vou te apresentar ao ${name}.`,
  name => `Deixa eu te conectar com o ${name} agora.`,
  name => `Ótima escolha. O ${name} está aqui com você.`,
  name => `Perfeito. Transferindo para o ${name}...`,
];

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Cache de agentes (evita ler 150+ arquivos a cada mensagem) ──
let _agentCache = null;
let _agentCacheAt = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCachedAgents() {
  if (!_agentCache || Date.now() - _agentCacheAt > CACHE_TTL) {
    _agentCache = getAgents();
    _agentCacheAt = Date.now();
  }
  return _agentCache;
}

// ── Setup ──
module.exports = function setupTelegram() {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  if (!TOKEN) return;

  const bot = new TelegramBot(TOKEN, { polling: true });
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const sessions = new Map();

  function session(chatId) {
    if (!sessions.has(chatId)) sessions.set(chatId, { agentId: null, messages: [], lastSaved: 0, greeted: false, voiceMode: false });
    return sessions.get(chatId);
  }


  // Pre-carrega agentes ao iniciar
  getCachedAgents();
  console.log('Telegram bot iniciado com sucesso.');

  // ── Roteamento inteligente: interpreta mensagem e seleciona agente automaticamente ──
  async function routeMessage(bot, chatId, text, s, replyWithVoice = false) {
    const agents = getCachedAgents();

    // Monta lista resumida de agentes para o roteador
    const agentList = agents
      .filter(a => a.squad !== 'geral' || a.agentId === 'controller-chief')
      .map(a => `id: ${a.id} | nome: ${a.name} | area: ${a.title}`)
      .join('\n');

    const jaFoiSaudado = s.greeted;

    const routerPrompt = `Voce e um roteador de conversas. Analise a mensagem do usuario e decida o que fazer.

AGENTES DISPONIVEIS:
${agentList}

MODO ATUAL: ${jaFoiSaudado ? 'JA SAUDOU — nunca repita saudacao' : 'PRIMEIRO CONTATO'}

REGRAS:
1. Se a mensagem indica qualquer tema, problema, area ou intencao — mesmo que junto com uma saudacao — identifique o melhor agente. Retorne: {"action":"route","agentId":"<id completo>"}
2. ${jaFoiSaudado
  ? 'Se a mensagem for confusa, vaga ou sem nexo — tente extrair qualquer intencao e pergunte de forma diferente da anterior para entender o que a pessoa precisa. Retorne: {"action":"clarify","question":"<pergunta curta e diferente>"}'
  : 'Se for saudacao pura sem nenhum tema ("oi", "ola", "bom dia", "hey", "tudo bem?") — retorne: {"action":"greet"}'
}
3. Se tiver contexto mas for ambiguo para escolher o agente — retorne: {"action":"clarify","question":"<pergunta curta e direta>"}

Prefira sempre rotear (acao 1). ${jaFoiSaudado ? 'NUNCA retorne action greet.' : ''}
Responda APENAS com o JSON, sem explicacoes.`;

    try {
      const r = await openai.chat.completions.create({
        model: 'gpt-5.4-mini',
        messages: [
          { role: 'system', content: routerPrompt },
          { role: 'user', content: text }
        ],
        response_format: { type: 'json_object' }
      });

      const decision = JSON.parse(r.choices[0].message.content);

      // Modo 1: saudacao pura — responde uma unica vez e marca como saudado
      if (decision.action === 'greet') {
        const greetings = [
          'Ola! Como posso te ajudar hoje?',
          'Oi! O que voce precisa?',
          'Ola! Em que posso ser util?',
          'Oi, tudo certo! O que voce tem em mente?',
          'Ola! Pode falar — estou aqui.'
        ];
        s.greeted = true;
        await bot.sendMessage(chatId, randomFrom(greetings));
        return;
      }

      // Modo 2: clarificacao — pergunta diferente, nunca repete saudacao
      if (decision.action === 'clarify') {
        s.greeted = true;
        await bot.sendMessage(chatId, decision.question || 'O que voce esta precisando resolver?');
        return;
      }

      // Modo 3: roteamento — direciona para o agente e ja processa a mensagem
      if (decision.action === 'route' && decision.agentId) {
        const agent = agents.find(a => a.id === decision.agentId);
        if (!agent) {
          await bot.sendMessage(chatId, 'Escolha uma area para comecar:', { reply_markup: squadKeyboard() });
          return;
        }

        if (s.agentId && s.agentId !== agent.id && s.messages.length >= 4) {
          const prev = agents.find(a => a.id === s.agentId);
          if (prev) autoSaveMemory(prev, s.messages, openai);
        }

        Object.assign(s, { agentId: agent.id, messages: [], lastSaved: 0, greeted: false });

        await bot.sendMessage(chatId, randomFrom(HANDOFF_MESSAGES)(agent.name));
        await sleep(700);

        await processMessage(bot, chatId, text, s, agents, openai, replyWithVoice);
        return;
      }
    } catch (err) {
      console.error('Erro no roteador:', err.message);
    }

    // Fallback: mostra menu
    await bot.sendMessage(chatId, 'Escolha uma area para comecar:', { reply_markup: squadKeyboard() });
  }

  bot.onText(/\/start/, async (msg) => {
    const s = session(msg.chat.id);
    if (s.agentId && s.messages.length >= 4) {
      const agent = getCachedAgents().find(a => a.id === s.agentId);
      if (agent) autoSaveMemory(agent, s.messages, openai);
    }
    Object.assign(s, { agentId: null, messages: [], lastSaved: 0, greeted: false });
    await bot.sendMessage(msg.chat.id, randomFrom(START_GREETINGS));
  });

  bot.onText(/\/menu/, async (msg) => {
    const s = session(msg.chat.id);
    if (s.agentId && s.messages.length >= 4) {
      const agent = getCachedAgents().find(a => a.id === s.agentId);
      if (agent) autoSaveMemory(agent, s.messages, openai);
    }
    Object.assign(s, { agentId: null, messages: [], lastSaved: 0, greeted: false });
    await bot.sendMessage(msg.chat.id, 'Escolha uma area:', { reply_markup: squadKeyboard() });
  });

  bot.onText(/\/agente/, async (msg) => {
    const s = session(msg.chat.id);
    if (s.agentId && s.messages.length >= 4) {
      const agent = getCachedAgents().find(a => a.id === s.agentId);
      if (agent) autoSaveMemory(agent, s.messages, openai);
    }
    Object.assign(s, { agentId: null, messages: [], lastSaved: 0, greeted: false });
    await bot.sendMessage(msg.chat.id, 'Com qual area voce quer falar agora?', { reply_markup: squadKeyboard() });
  });

  bot.onText(/\/limpar/, async (msg) => {
    const s = session(msg.chat.id);
    s.messages = []; s.lastSaved = 0;
    await bot.sendMessage(msg.chat.id, 'Conversa limpa. Agente e memoria preservados.');
  });

  bot.onText(/\/voz/, async (msg) => {
    const s = session(msg.chat.id);
    s.voiceMode = !s.voiceMode;
    await bot.sendMessage(msg.chat.id, s.voiceMode
      ? 'Modo voz ativado. O agente vai responder em audio.'
      : 'Modo voz desativado. Respostas em texto novamente.'
    );
  });

  bot.onText(/\/status/, async (msg) => {
    const s = session(msg.chat.id);
    if (!s.agentId) { await bot.sendMessage(msg.chat.id, 'Nenhum agente ativo. Use /start.'); return; }
    const agent = getCachedAgents().find(a => a.id === s.agentId);
    const isOrch = agent?.delegates?.length > 0;
    const hasMem = !!getMemoryContent(s.agentId);
    await bot.sendMessage(msg.chat.id,
      `Agente: ${agent?.name || s.agentId}\n` +
      `Tipo: ${isOrch ? `Orquestrador (${agent.delegates.length} especialistas)` : 'Especialista'}\n` +
      `Memoria: ${hasMem ? 'Ativa' : 'Sem memoria ainda'}\n` +
      `Mensagens na sessao: ${s.messages.length}`
    );
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const agents = getCachedAgents();
    await bot.answerCallbackQuery(query.id).catch(() => {});

    try {
      if (data.startsWith('squad:')) {
        await bot.editMessageReplyMarkup(
          agentKeyboard(agents, data.slice(6)),
          { chat_id: chatId, message_id: query.message.message_id }
        ).catch(() => {});

      } else if (data.startsWith('agent:')) {
        const agent = agents.find(a => a.id === data.slice(6));
        if (!agent) {
          await bot.sendMessage(chatId, 'Agente nao encontrado. Use /start para recomecar.');
          return;
        }
        const s = session(chatId);
        if (s.agentId && s.agentId !== agent.id && s.messages.length >= 4) {
          const prev = agents.find(a => a.id === s.agentId);
          if (prev) autoSaveMemory(prev, s.messages, openai);
        }
        Object.assign(s, { agentId: agent.id, messages: [], lastSaved: 0 });
        const label = `${agent.name}${agent.delegates?.length > 0 ? ' (Orquestrador)' : ''}${getMemoryContent(agent.id) ? ' | Mem ativa' : ''}`;
        await bot.editMessageText(label, { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
        await bot.sendMessage(chatId, randomFrom(HANDOFF_MESSAGES)(agent.name));
        await sleep(900);
        await sendHumanized(bot, chatId, agent.greeting);

      } else if (data === 'back:squads') {
        await bot.editMessageReplyMarkup(
          squadKeyboard(),
          { chat_id: chatId, message_id: query.message.message_id }
        ).catch(() => {});

      } else if (data.startsWith('opt:')) {
        const choice = data.slice(4);
        const s = session(chatId);
        if (!s.agentId) return;
        await bot.sendMessage(chatId, choice);
        await processMessage(bot, chatId, choice, s, agents, openai);
      }
    } catch (err) {
      console.error('callback_query error:', err.message);
      await bot.sendMessage(chatId, 'Algo deu errado. Tente novamente ou use /start.').catch(() => {});
    }
  });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || msg.text.startsWith('/')) return;
    const s = session(chatId);

    // Sem agente ativo — roteia automaticamente
    if (!s.agentId) {
      await routeMessage(bot, chatId, msg.text, s);
      return;
    }

    // Agente ja ativo — conversa continua normalmente
    await processMessage(bot, chatId, msg.text, s, getCachedAgents(), openai);
  });

  // ── Audio e voz: transcreve com Whisper e processa como texto ──
  async function handleAudio(msg, fileId) {
    const chatId = msg.chat.id;
    const s = session(chatId);
    let tmpPath = null;
    try {
      await bot.sendChatAction(chatId, 'typing');
      const fileLink = await bot.getFileLink(fileId);
      tmpPath = path.join(os.tmpdir(), `tg_audio_${Date.now()}.ogg`);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      fs.writeFileSync(tmpPath, response.data);
      const transcription = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: 'whisper-1',
        language: 'pt'
      });
      const text = transcription.text?.trim();
      if (!text) { await bot.sendMessage(chatId, 'Nao consegui entender o audio. Tente novamente.'); return; }
      if (!s.agentId) { await routeMessage(bot, chatId, text, s, true); return; }
      await processMessage(bot, chatId, text, s, getCachedAgents(), openai, true);
    } catch (err) {
      console.error('Erro audio:', err.message);
      await bot.sendMessage(chatId, 'Erro ao processar o audio. Tente novamente.');
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  }

  bot.on('voice',   msg => handleAudio(msg, msg.voice.file_id));
  bot.on('audio',   msg => handleAudio(msg, msg.audio.file_id));

  // ── Imagens: envia para o modelo com visao ──
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    const s = session(chatId);
    try {
      await bot.sendChatAction(chatId, 'typing');
      const photo = msg.photo[msg.photo.length - 1];
      const fileLink = await bot.getFileLink(photo.file_id);
      const caption = msg.caption || 'O que voce ve nessa imagem? Descreva e analise em detalhes.';
      const agent = getCachedAgents().find(a => a.id === s.agentId);
      const systemPrompt = agent
        ? agent.systemPrompt
        : 'Voce e um assistente especializado. Analise a imagem com atencao e responda de forma clara e util.';
      const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);
      const completion = await openai.chat.completions.create({
        model: 'gpt-5.4',
        messages: [
          { role: 'system', content: systemPrompt },
          ...( s.messages.slice(-6) ),
          { role: 'user', content: [
            { type: 'text', text: caption },
            { type: 'image_url', image_url: { url: fileLink, detail: 'high' } }
          ]}
        ]
      });
      clearInterval(typingInterval);
      const reply = completion.choices[0].message.content;
      s.messages.push({ role: 'user', content: caption });
      s.messages.push({ role: 'assistant', content: reply });
      await sendHumanized(bot, chatId, reply);
    } catch (err) {
      console.error('Erro imagem:', err.message);
      await bot.sendMessage(chatId, 'Erro ao processar a imagem. Tente novamente.');
    }
  });

  // ── Documentos: PDF extrai texto, imagens usam visao, outros nao suportados ──
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    const s = session(chatId);
    const doc = msg.document;
    const mime = doc.mime_type || '';
    const caption = msg.caption || '';
    let tmpPath = null;
    try {
      await bot.sendChatAction(chatId, 'typing');
      const fileLink = await bot.getFileLink(doc.file_id);
      const response = await axios.get(fileLink, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(response.data);
      tmpPath = path.join(os.tmpdir(), `tg_doc_${Date.now()}_${doc.file_name || 'file'}`);
      fs.writeFileSync(tmpPath, buffer);

      const isExcel = mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
                      mime === 'application/vnd.ms-excel' ||
                      /\.(xlsx|xls)$/i.test(doc.file_name || '');

      const isPptx = mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
                     mime === 'application/vnd.ms-powerpoint' ||
                     /\.(pptx|ppt)$/i.test(doc.file_name || '');

      if (mime === 'application/pdf') {
        const parsed = await pdfParse(buffer);
        const texto = parsed.text.trim().slice(0, 12000);
        if (!texto) { await bot.sendMessage(chatId, 'Nao consegui extrair texto deste PDF.'); return; }
        const prompt = caption
          ? `${caption}\n\n--- CONTEUDO DO PDF (${doc.file_name}) ---\n${texto}`
          : `Analise o seguinte documento PDF chamado "${doc.file_name}" e faca um resumo dos pontos principais:\n\n${texto}`;
        if (!s.agentId) { await routeMessage(bot, chatId, prompt, s); return; }
        await processMessage(bot, chatId, prompt, s, getCachedAgents(), openai);

      } else if (isExcel) {
        const wb = XLSX.read(buffer, { type: 'buffer' });
        const linhas = [];
        for (const sheetName of wb.SheetNames) {
          const sheet = wb.Sheets[sheetName];
          const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
          if (csv.trim()) linhas.push(`--- Aba: ${sheetName} ---\n${csv}`);
        }
        const texto = linhas.join('\n\n').slice(0, 12000);
        if (!texto) { await bot.sendMessage(chatId, 'Nao consegui extrair dados desta planilha.'); return; }
        const prompt = caption
          ? `${caption}\n\n--- PLANILHA: ${doc.file_name} ---\n${texto}`
          : `Analise a planilha "${doc.file_name}" e explique o que contem, destacando os principais dados e padroes:\n\n${texto}`;
        if (!s.agentId) { await routeMessage(bot, chatId, prompt, s); return; }
        await processMessage(bot, chatId, prompt, s, getCachedAgents(), openai);

      } else if (isPptx) {
        const texto = await new Promise((resolve, reject) => {
          officeParser.parseOfficeAsync(tmpPath)
            .then(data => resolve(data?.slice(0, 12000) || ''))
            .catch(reject);
        });
        if (!texto.trim()) { await bot.sendMessage(chatId, 'Nao consegui extrair texto desta apresentacao.'); return; }
        const prompt = caption
          ? `${caption}\n\n--- APRESENTACAO: ${doc.file_name} ---\n${texto}`
          : `Analise a apresentacao "${doc.file_name}" e faca um resumo dos slides e pontos principais:\n\n${texto}`;
        if (!s.agentId) { await routeMessage(bot, chatId, prompt, s); return; }
        await processMessage(bot, chatId, prompt, s, getCachedAgents(), openai);

      } else if (mime.startsWith('image/')) {
        const base64 = buffer.toString('base64');
        const agent = getCachedAgents().find(a => a.id === s.agentId);
        const systemPrompt = agent?.systemPrompt || 'Voce e um assistente especializado. Analise a imagem.';
        const typingInterval = setInterval(() => bot.sendChatAction(chatId, 'typing'), 4000);
        const completion = await openai.chat.completions.create({
          model: 'gpt-5.4',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: [
              { type: 'text', text: caption || 'Analise esta imagem em detalhes.' },
              { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } }
            ]}
          ]
        });
        clearInterval(typingInterval);
        const reply = completion.choices[0].message.content;
        s.messages.push({ role: 'user', content: caption || 'Imagem enviada' });
        s.messages.push({ role: 'assistant', content: reply });
        await sendHumanized(bot, chatId, reply);

      } else {
        await bot.sendMessage(chatId, `Formato nao suportado (${mime || 'desconhecido'}). Envie PDF, Excel, PowerPoint, imagem ou mensagem de voz.`);
      }
    } catch (err) {
      console.error('Erro documento:', err.message);
      await bot.sendMessage(chatId, 'Erro ao processar o arquivo. Tente novamente.');
    } finally {
      if (tmpPath && fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
  });

  bot.on('polling_error', err => {
    if (err.code !== 'ETELEGRAM') console.error('Telegram polling:', err.message);
  });

  // Evita que erros do Telegram derrubem o processo inteiro
  process.on('unhandledRejection', err => {
    if (err?.code === 'ETELEGRAM') return; // ignora erros esperados do Telegram
    console.error('Unhandled rejection:', err?.message);
  });
};
