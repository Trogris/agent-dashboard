const express = require('express');
const { OpenAI } = require('openai');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const COMMANDS_DIR = path.join(__dirname, '../.claude/commands');

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
        const greeting = extractGreeting(content) || `Ola! Sou o ${name}. Como posso ajudar?`;

        agents.push({
          id: squad ? `${squad}/${agentId}` : agentId,
          agentId,
          squad: squad || 'geral',
          name,
          title,
          systemPrompt: activation,
          greeting
        });
      }
    }
  }

  scanDir(COMMANDS_DIR, null);
  return agents;
}

app.get('/api/agents', (req, res) => {
  try {
    const agents = getAgents();
    res.json(agents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const { messages, systemPrompt, apiKey } = req.body;

  if (!apiKey) return res.status(400).json({ error: 'API key nao informada' });

  const openai = new OpenAI({ apiKey });

  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages
      ],
      stream: true
    });

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for await (const chunk of completion) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Agent Dashboard rodando em http://localhost:${PORT}`);
});
