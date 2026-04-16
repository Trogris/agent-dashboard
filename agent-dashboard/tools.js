require('dotenv').config();

// ─────────────────────────────────────────────────────────────────────────────
//  FASE 1: Busca na web + leitura de paginas
//  FASE 2/3: Google Calendar + Gmail (adicionar aqui quando credenciais prontas)
// ─────────────────────────────────────────────────────────────────────────────

// ── Definicoes das ferramentas (formato OpenAI function calling) ──────────────

const WEB_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'buscar_na_web',
      description: 'Busca informacoes atualizadas na internet. Use quando precisar de dados recentes, noticias, precos, eventos, pesquisas de mercado ou qualquer informacao que possa ter mudado. Prefira buscar antes de responder sobre assuntos que evoluem com frequencia.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Consulta de busca — pode ser em portugues ou ingles. Seja especifico para obter resultados melhores.'
          },
          num_results: {
            type: 'number',
            description: 'Numero de resultados desejados (padrao: 5, maximo: 10)'
          }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ler_pagina',
      description: 'Le e extrai o conteudo de uma pagina web a partir de uma URL. Use para aprofundar em um resultado de busca, analisar um artigo completo, verificar um site especifico ou ler documentacao.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL completa da pagina (deve comecar com http:// ou https://)'
          }
        },
        required: ['url']
      }
    }
  }
];

// ── Exporta as definicoes ativas ──────────────────────────────────────────────
// Adicione aqui as ferramentas de Calendar e Gmail quando implementadas
const TOOL_DEFINITIONS = [...WEB_TOOLS];

// ─────────────────────────────────────────────────────────────────────────────
//  Implementacoes internas
// ─────────────────────────────────────────────────────────────────────────────

// Busca via Tavily (recomendado — gratuito ate 1000 buscas/mes: tavily.com)
async function searchTavily(query, numResults) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: process.env.TAVILY_API_KEY,
      query,
      max_results: Math.min(numResults || 5, 10),
      search_depth: 'basic',
      include_answer: true
    }),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`Tavily HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const parts = [];
  if (data.answer) parts.push(`Resposta direta: ${data.answer}\n`);
  for (const r of data.results || []) {
    parts.push(`## ${r.title}\nURL: ${r.url}\n${(r.content || '').slice(0, 600)}`);
  }
  return parts.join('\n\n---\n\n') || 'Nenhum resultado encontrado.';
}

// Busca via DuckDuckGo lite (fallback sem chave de API)
async function searchDuckDuckGo(query, numResults) {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      'Accept': 'text/html'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`DuckDuckGo HTTP ${res.status}`);
  const html = await res.text();

  // DDG lite usa aspas simples nas classes
  // Extrai titulos dos links
  const titleRe = /class='result-link'[^>]*>([\s\S]*?)<\/a>/g;
  // Extrai hrefs — formato: href="//duckduckgo.com/l/?uddg=URL_ENCODED"
  const hrefRe = /href="([^"]+)"[^>]*class='result-link'/g;
  // Extrai snippets
  const snippetRe = /class='result-snippet'[^>]*>([\s\S]*?)<\/td>/g;

  const titles = [...html.matchAll(titleRe)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const hrefs = [...html.matchAll(hrefRe)].map(m => {
    // Decodifica URL do redirect do DDG: //duckduckgo.com/l/?uddg=https%3A%2F%2F...
    const match = m[1].match(/uddg=([^&]+)/);
    if (match) {
      try { return decodeURIComponent(match[1]); } catch { return m[1]; }
    }
    return m[1].startsWith('//') ? 'https:' + m[1] : m[1];
  });
  const snippets = [...html.matchAll(snippetRe)].map(m =>
    m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
  );

  const count = Math.min(titles.length, numResults || 5);
  if (count === 0) {
    return 'Nenhum resultado encontrado. Para buscas mais precisas, configure TAVILY_API_KEY no .env (gratis em tavily.com).';
  }

  const results = [];
  for (let i = 0; i < count; i++) {
    results.push(`## ${titles[i] || `Resultado ${i + 1}`}\nURL: ${hrefs[i] || ''}\n${snippets[i] || ''}`);
  }
  return results.join('\n\n---\n\n');
}

// Strip HTML — remove scripts, estilos, navegacao; extrai texto limpo
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[\s\S]*?<\/aside>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x[0-9a-fA-F]+;/g, c => { try { return String.fromCodePoint(parseInt(c.slice(3,-1),16)); } catch { return ''; } })
    .replace(/&#[0-9]+;/g, c => { try { return String.fromCodePoint(parseInt(c.slice(2,-1))); } catch { return ''; } })
    .replace(/\s{3,}/g, '\n\n')
    .trim()
    .slice(0, 12000);
}

// Leitura de pagina via fetch
async function readPage(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AgentBot/1.0; +https://agentdashboard.app)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8'
    },
    signal: AbortSignal.timeout(20000)
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ao acessar ${url}`);
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
    throw new Error(`Tipo de conteudo nao suportado: ${contentType}`);
  }
  const html = await res.text();
  const text = stripHtml(html);
  if (!text.trim()) throw new Error('Pagina sem conteudo legivel.');
  return `URL: ${url}\n\n${text}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Executor de ferramentas (roteador central)
// ─────────────────────────────────────────────────────────────────────────────

async function executeTool(name, args) {
  switch (name) {
    case 'buscar_na_web': {
      const { query, num_results = 5 } = args;
      if (!query?.trim()) return 'Parametro "query" e obrigatorio.';
      if (process.env.TAVILY_API_KEY) {
        return await searchTavily(query.trim(), num_results);
      } else {
        return await searchDuckDuckGo(query.trim(), num_results);
      }
    }
    case 'ler_pagina': {
      const { url } = args;
      if (!url?.trim()) return 'Parametro "url" e obrigatorio.';
      return await readPage(url.trim());
    }
    // FASE 2 — Google Calendar (adicionar aqui)
    // case 'listar_eventos': ...
    // case 'criar_evento': ...
    // case 'cancelar_evento': ...

    // FASE 3 — Gmail (adicionar aqui)
    // case 'enviar_email': ...
    // case 'ler_emails': ...

    default:
      return `Ferramenta desconhecida: ${name}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Loop agentico (versao nao-streaming — Telegram e orchestrate)
// ─────────────────────────────────────────────────────────────────────────────

async function runWithTools(openai, { model, systemPrompt, messages, maxIterations = 4, extraTools = [] }) {
  const tools = [...TOOL_DEFINITIONS, ...extraTools];
  let msgs = [...messages];

  for (let i = 0; i < maxIterations; i++) {
    const res = await openai.chat.completions.create({
      model,
      messages: [{ role: 'system', content: systemPrompt }, ...msgs],
      tools,
      tool_choice: 'auto'
    });

    const msg = res.choices[0].message;

    // Sem tool_calls → resposta final
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content;
    }

    msgs.push(msg);
    for (const tc of msg.tool_calls) {
      let result;
      try {
        const parsed = JSON.parse(tc.function.arguments);
        result = await executeTool(tc.function.name, parsed);
      } catch (err) {
        result = `Erro ao executar ferramenta: ${err.message}`;
      }
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
    }
  }

  // Atingiu limite de iteracoes — pede resposta final sem ferramentas
  const fallback = await openai.chat.completions.create({
    model,
    messages: [{ role: 'system', content: systemPrompt }, ...msgs]
  });
  return fallback.choices[0].message.content;
}

module.exports = { TOOL_DEFINITIONS, executeTool, runWithTools };
