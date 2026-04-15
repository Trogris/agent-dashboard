require('dotenv').config();

const express = require('express');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const COMMANDS_DIR = path.join(__dirname, 'agents');
const OUTPUTS_DIR = path.join(__dirname, 'outputs');

if (!process.env.VERCEL && !fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR);

function extractActivationNotice(content) {
  const match = content.match(/ACTIVATION-NOTICE:\s*(.*?)(?:\n\n|$)/s);
  return match ? match[1].trim() : null;
}

function extractTitle(content) {
  const match = content.match(/title:\s*"([^"]+)"/);
  return match ? match[1] : null;
}

function extractGreeting(content) {
  const match = content.match(/greeting:\s*"([^"]+)"/s);
  return match ? match[1].replace(/\\n/g, '\n').trim() : null;
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
        const greeting = extractGreeting(content) || `Olá! Sou o ${name}. Como posso ajudar?`;
        agents.push({
          id: squad ? `${squad}/${agentId}` : agentId,
          agentId, squad: squad || 'geral',
          name, title, systemPrompt: activation, greeting
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
  const { messages, systemPrompt, apiKey } = req.body;
  const key = (process.env.OPENAI_API_KEY &&
    !['cole_sua_chave_aqui','cole_sua_nova_chave_aqui'].includes(process.env.OPENAI_API_KEY))
    ? process.env.OPENAI_API_KEY : apiKey;

  if (!key) return res.status(400).json({ error: 'Chave da API não configurada.' });

  const openai = new OpenAI({ apiKey: key });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      stream: true
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const chunk of completion) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) res.write(`data: ${JSON.stringify({ content })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
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
  });
}

module.exports = app;
