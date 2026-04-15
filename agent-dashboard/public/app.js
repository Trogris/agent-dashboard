let agents = [];
let currentAgent = null;
let messages = [];
let apiKey = localStorage.getItem('openai_key') || '';
let viewMode = 'grid';
let filterCategory = 'all';

// ── Squad metadata ──
const squadMeta = {
  'c-level-squad':      { label: 'C-Level Squad',       icon: 'CL', colorClass: 'clevel'   },
  'advisory-board':     { label: 'Advisory Board',      icon: 'AB', colorClass: 'advisory' },
  'hormozi-squad':      { label: 'Hormozi Squad',       icon: 'HS', colorClass: 'hormozi'  },
  'copy-master':        { label: 'Copy Master',         icon: 'CM', colorClass: 'copy'     },
  'copy-squad':         { label: 'Copy Squad',          icon: 'CS', colorClass: 'copy'     },
  'brand-squad':        { label: 'Brand Squad',         icon: 'BR', colorClass: 'brand'    },
  'traffic-masters':    { label: 'Traffic Masters',     icon: 'TM', colorClass: 'traffic'  },
  'storytelling':       { label: 'Storytelling',        icon: 'ST', colorClass: 'story'    },
  'design-squad':       { label: 'Design Squad',        icon: 'DS', colorClass: 'design'   },
  'data-squad':         { label: 'Data Squad',          icon: 'DA', colorClass: 'data'     },
  'cybersecurity':      { label: 'Cybersecurity',       icon: 'CY', colorClass: 'cyber'    },
  'claude-code-mastery':{ label: 'Claude Code Mastery', icon: 'CC', colorClass: 'mastery'  },
  'movement':           { label: 'Movement',            icon: 'MV', colorClass: 'movement' },
  'problem-solver-squad':{ label: 'Resolução de Problemas', icon: 'RP', colorClass: 'problem' },
  'geral':              { label: 'Finanças & Custos',    icon: 'FC', colorClass: 'default'  },
  'industrial':         { label: 'Industrial',           icon: 'IN', colorClass: 'industrial' }
};

// ── Category groupings by activity type ──
const activityCategories = {
  all: { label: 'Todos' },
  strategy: {
    label: 'Estratégia & Liderança',
    squads: ['c-level-squad', 'advisory-board']
  },
  marketing: {
    label: 'Marketing & Tráfego',
    squads: ['traffic-masters', 'brand-squad', 'movement']
  },
  sales: {
    label: 'Vendas & Crescimento',
    squads: ['hormozi-squad', 'data-squad']
  },
  copy: {
    label: 'Copywriting & Narrativa',
    squads: ['copy-master', 'copy-squad', 'storytelling']
  },
  operations: {
    label: 'Operações & Problemas',
    squads: ['problem-solver-squad']
  },
  finance: {
    label: 'Controladoria & Finanças',
    squads: ['geral']
  },
  industrial: {
    label: 'Industrial & Operações',
    squads: ['industrial']
  },
  tech: {
    label: 'Tecnologia & Design',
    squads: ['design-squad', 'cybersecurity', 'claude-code-mastery']
  }
};

// ── Determina o modelo por agente ──
function getModelForAgent(agent) {
  const powerSquads = ['c-level-squad', 'advisory-board'];
  const powerKeywords = ['chief', 'orchestrator', 'architect', 'vision', 'board-chair'];
  if (powerSquads.includes(agent.squad)) return 'gpt-5.4';
  if (powerKeywords.some(k =>
    agent.agentId.toLowerCase().includes(k) ||
    agent.name.toLowerCase().includes(k)
  )) return 'gpt-5.4';
  return 'gpt-5.4-mini';
}

const squadOrder = [
  'c-level-squad','advisory-board','problem-solver-squad','hormozi-squad',
  'copy-master','copy-squad','brand-squad','traffic-masters',
  'storytelling','design-squad','data-squad','cybersecurity',
  'claude-code-mastery','movement','industrial','geral'
];

// ── Setup Screen ──
const setupScreen = document.getElementById('setupScreen');
const appScreen = document.getElementById('appScreen');
const setupApiKey = document.getElementById('setupApiKey');
const setupEnterBtn = document.getElementById('setupEnterBtn');

function showApp() {
  setupScreen.style.display = 'none';
  appScreen.style.display = 'flex';
  appScreen.style.flexDirection = 'column';
  appScreen.style.height = '100vh';
  init();
}

// Verifica se o servidor já tem a chave configurada no .env
fetch('/api/config')
  .then(r => r.json())
  .then(({ hasServerKey }) => {
    if (hasServerKey || apiKey) showApp();
  });

setupEnterBtn.addEventListener('click', () => {
  const val = setupApiKey.value.trim();
  if (!val) return;
  apiKey = val;
  localStorage.setItem('openai_key', apiKey);
  showApp();
});

setupApiKey.addEventListener('keydown', e => {
  if (e.key === 'Enter') setupEnterBtn.click();
});

// ── Modal ──
const keyModal = document.getElementById('keyModal');
const changeKeyBtn = document.getElementById('changeKeyBtn');
const modalBackdrop = document.getElementById('modalBackdrop');
const modalCancel = document.getElementById('modalCancel');
const modalSave = document.getElementById('modalSave');
const modalApiKey = document.getElementById('modalApiKey');

changeKeyBtn.addEventListener('click', () => { keyModal.style.display = 'block'; modalApiKey.focus(); });
modalBackdrop.addEventListener('click', () => keyModal.style.display = 'none');
modalCancel.addEventListener('click', () => keyModal.style.display = 'none');
modalSave.addEventListener('click', () => {
  const val = modalApiKey.value.trim();
  if (!val) return;
  apiKey = val;
  localStorage.setItem('openai_key', apiKey);
  modalApiKey.value = '';
  keyModal.style.display = 'none';
});

// ── View toggle ──
document.getElementById('gridViewBtn').addEventListener('click', () => {
  viewMode = 'grid';
  document.getElementById('gridViewBtn').classList.add('active');
  document.getElementById('listViewBtn').classList.remove('active');
  renderAgents(agents);
});

document.getElementById('listViewBtn').addEventListener('click', () => {
  viewMode = 'list';
  document.getElementById('listViewBtn').classList.add('active');
  document.getElementById('gridViewBtn').classList.remove('active');
  renderAgents(agents);
});

// ── Search ──
document.getElementById('searchInput').addEventListener('input', e => {
  const q = e.target.value.toLowerCase();
  const filtered = q
    ? agents.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.squad.toLowerCase().includes(q)
      )
    : agents;
  renderAgents(filtered);
});

// ── Init ──
async function init() {
  await loadAgents();
  buildCategoryFilter();
}

async function loadAgents() {
  const res = await fetch('/api/agents');
  agents = await res.json();
  renderAgents(agents);

  // Stats
  const squads = new Set(agents.map(a => a.squad)).size;
  document.getElementById('emptyStats').innerHTML = `
    <div class="stat-item"><div class="stat-num">${agents.length}</div><div class="stat-label">Agentes</div></div>
    <div class="stat-item"><div class="stat-num">${squads}</div><div class="stat-label">Áreas</div></div>
  `;
}

// ── Category Filter ──
function buildCategoryFilter() {
  const container = document.getElementById('agentsContent');

  // Insert category pills above content
  const pillsHtml = Object.entries(activityCategories).map(([key, cat]) => `
    <button class="cat-pill ${key === 'all' ? 'active' : ''}" data-cat="${key}">
      ${cat.label}
    </button>
  `).join('');

  const pillsContainer = document.createElement('div');
  pillsContainer.id = 'catPills';
  pillsContainer.innerHTML = pillsHtml;
  pillsContainer.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:24px;';
  container.parentElement.insertBefore(pillsContainer, container);

  // Pill style
  const style = document.createElement('style');
  style.textContent = `
    .cat-pill {
      display: flex; align-items: center; gap: 6px;
      background: var(--surface2); border: 1px solid var(--border);
      border-radius: 20px; padding: 6px 14px;
      font-size: 12px; font-weight: 600; color: var(--text2);
      cursor: pointer; font-family: inherit; transition: all .15s;
    }
    .cat-pill:hover { border-color: var(--border2); color: var(--text); }
    .cat-pill.active {
      background: rgba(99,91,255,.15);
      border-color: rgba(99,91,255,.4);
      color: #9d99ff;
    }
  `;
  document.head.appendChild(style);

  document.querySelectorAll('.cat-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cat-pill').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterCategory = btn.dataset.cat;
      const filtered = getFilteredAgents();
      renderAgents(filtered);
    });
  });
}

function getFilteredAgents() {
  if (filterCategory === 'all') return agents;
  const cat = activityCategories[filterCategory];
  if (!cat || !cat.squads) return agents;
  return agents.filter(a => cat.squads.includes(a.squad));
}

// ── Render ──
function getSquadMeta(squad) {
  return squadMeta[squad] || { label: squad, icon: '◈', colorClass: 'default' };
}

function getInitials(name) {
  return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function renderAgents(list) {
  const container = document.getElementById('agentsContent');
  container.innerHTML = '';

  if (!list.length) {
    container.innerHTML = '<p style="color:var(--text3);font-size:13px;padding:20px 0">Nenhum agente encontrado.</p>';

    return;
  }

  // Group by squad
  const grouped = {};
  for (const agent of list) {
    if (!grouped[agent.squad]) grouped[agent.squad] = [];
    grouped[agent.squad].push(agent);
  }

  const orderedSquads = [
    ...squadOrder.filter(s => grouped[s]),
    ...Object.keys(grouped).filter(s => !squadOrder.includes(s))
  ];

  for (const squad of orderedSquads) {
    if (!grouped[squad]) continue;
    const meta = getSquadMeta(squad);
    const section = document.createElement('div');
    section.className = 'squad-section';

    section.innerHTML = `
      <div class="squad-header">
        <div class="squad-icon sq-${meta.colorClass}">${meta.icon}</div>
        <span class="squad-name">${meta.label}</span>
        <span class="squad-count">${grouped[squad].length} agentes</span>
      </div>
      <div class="${viewMode === 'grid' ? 'agents-grid' : 'agents-list'}"></div>
    `;

    const grid = section.querySelector('.agents-grid, .agents-list');

    for (const agent of grouped[squad]) {
      if (viewMode === 'grid') {
        const card = document.createElement('div');
        card.className = `agent-card ${currentAgent?.id === agent.id ? 'active' : ''}`;
        card.innerHTML = `
          <div class="card-avatar sq-${meta.colorClass}">${getInitials(agent.name)}</div>
          <div class="card-name">${agent.name}</div>
          <div class="card-title">${agent.title || ''}</div>
          <div class="accent-${meta.colorClass}" style="position:absolute;top:0;left:0;right:0;height:3px;border-radius:14px 14px 0 0;${currentAgent?.id === agent.id ? 'opacity:1' : 'opacity:0'}"></div>
        `;
        card.querySelector('.accent-' + meta.colorClass).style.cssText +=
          currentAgent?.id === agent.id
            ? 'opacity:1!important;'
            : 'transition:opacity .2s;';
        card.addEventListener('mouseenter', () => {
          card.querySelector('[class*="accent-"]').style.opacity = '1';
        });
        card.addEventListener('mouseleave', () => {
          if (currentAgent?.id !== agent.id)
            card.querySelector('[class*="accent-"]').style.opacity = '0';
        });
        card.addEventListener('click', () => activateAgent(agent, meta));
        grid.appendChild(card);
      } else {
        const item = document.createElement('div');
        item.className = `agent-list-item ${currentAgent?.id === agent.id ? 'active' : ''}`;
        item.innerHTML = `
          <div class="list-avatar sq-${meta.colorClass}">${getInitials(agent.name)}</div>
          <div>
            <div class="list-name">${agent.name}</div>
            <div class="list-title">${agent.title || ''}</div>
          </div>
        `;
        item.addEventListener('click', () => activateAgent(agent, meta));
        grid.appendChild(item);
      }
    }

    container.appendChild(section);
  }
}

// ── Persistência de conversas ──
function saveConversation(agentId) {
  localStorage.setItem('chat_' + agentId, JSON.stringify(messages));
}
function loadConversation(agentId) {
  try { return JSON.parse(localStorage.getItem('chat_' + agentId)) || null; } catch { return null; }
}
function clearConversation(agentId) {
  localStorage.removeItem('chat_' + agentId);
}

// ── Activate Agent ──
function activateAgent(agent, meta) {
  if (!meta) meta = getSquadMeta(agent.squad);
  currentAgent = agent;

  // Re-render to update active state
  const filtered = getFilteredAgents();
  renderAgents(filtered);

  // Open chat panel
  document.getElementById('chatPanel').classList.add('chat-open');
  document.getElementById('chatEmpty').style.display = 'none';
  document.getElementById('chatActive').style.display = 'flex';
  document.getElementById('chatActive').style.flexDirection = 'column';
  document.getElementById('chatActive').style.overflow = 'hidden';
  document.getElementById('chatActive').style.flex = '1';

  // Set header
  document.getElementById('chatAvatar').textContent = getInitials(agent.name);
  document.getElementById('chatAvatar').className = `chat-agent-avatar sq-${meta.colorClass}`;
  document.getElementById('chatAgentName').textContent = agent.name;
  const agentModel = getModelForAgent(agent);
  document.getElementById('chatAgentSquad').textContent = meta.label + (agent.title ? ` · ${agent.title}` : '') + ` · ${agentModel}`;

  // Restaura conversa salva ou mostra greeting
  const messagesEl = document.getElementById('messages');
  messagesEl.innerHTML = '';
  const saved = loadConversation(agent.id);
  if (saved && saved.length > 0) {
    messages = saved;
    for (const m of messages) addMessage(m.role, m.content, meta);
  } else {
    messages = [];
    addMessage('assistant', agent.greeting, meta);
    messages = [];
  }

  document.getElementById('userInput').focus();
}

// ── Close chat ──
document.getElementById('closeChat').addEventListener('click', () => {
  document.getElementById('chatPanel').classList.remove('chat-open');
  document.getElementById('chatEmpty').style.display = '';
  document.getElementById('chatActive').style.display = 'none';
  currentAgent = null;
  renderAgents(getFilteredAgents());
});

// ── Clear chat ──
document.getElementById('clearBtn').addEventListener('click', () => {
  if (!currentAgent) return;
  messages = [];
  clearConversation(currentAgent.id);
  document.getElementById('messages').innerHTML = '';
  const meta = getSquadMeta(currentAgent.squad);
  addMessage('assistant', currentAgent.greeting, meta);
  messages = [];
});

// ── Executa JavaScript no browser (gera arquivos via SheetJS / jsPDF / PptxGenJS) ──
async function executeJavaScript(code) {
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const fn = new AsyncFunction(code);
  await fn();
}

// ── Detecta e renderiza blocos de código com botão de execução ──
function renderMessageContent(bubble, content) {
  // Detecta python e javascript
  const codeRegex = /```(python|javascript)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  let hasCode = false;

  bubble.innerHTML = '';

  while ((match = codeRegex.exec(content)) !== null) {
    hasCode = true;
    const lang = match[1];
    const code = match[2];

    // Texto antes do bloco
    if (match.index > lastIndex) {
      const textNode = document.createElement('p');
      textNode.style.cssText = 'margin:0 0 10px;white-space:pre-wrap;';
      textNode.textContent = content.slice(lastIndex, match.index);
      bubble.appendChild(textNode);
    }

    // Bloco de código
    const codeBlock = document.createElement('div');
    codeBlock.className = 'code-block';
    const langLabel = lang === 'python' ? 'Python' : 'JavaScript';
    codeBlock.innerHTML = `
      <div class="code-header">
        <div class="code-header-left">
          <span class="code-lang-badge">${langLabel}</span>
          <button class="code-toggle-btn">ver código</button>
        </div>
        <button class="run-btn" data-code="${encodeURIComponent(code)}" data-lang="${lang}">
          <svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><polygon points="5,3 19,12 5,21"/></svg>
          Gerar arquivo
        </button>
      </div>
      <div class="code-body">
        <pre><code>${escapeHtml(code)}</code></pre>
      </div>
    `;

    // Toggle código
    codeBlock.querySelector('.code-toggle-btn').addEventListener('click', function() {
      const body = codeBlock.querySelector('.code-body');
      const expanded = body.classList.toggle('expanded');
      this.textContent = expanded ? 'ocultar código' : 'ver código';
    });

    const resultArea = document.createElement('div');
    resultArea.className = 'file-result';
    codeBlock.appendChild(resultArea);

    codeBlock.querySelector('.run-btn').addEventListener('click', async function() {
      const btn = this;
      const decodedCode = decodeURIComponent(btn.dataset.code);
      const language = btn.dataset.lang;
      btn.disabled = true;
      btn.innerHTML = '<span class="spin">⟳</span> Gerando...';
      resultArea.innerHTML = '';

      try {
        if (language === 'javascript') {
          await executeJavaScript(decodedCode);
          resultArea.innerHTML = `
            <div class="result-success">
              <div class="result-success-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><polyline points="20,6 9,17 4,12"/></svg>
              </div>
              <div class="result-success-text">
                <div class="title">Arquivo gerado com sucesso</div>
                <div class="sub">Verifique sua pasta de Downloads</div>
              </div>
            </div>`;
        } else {
          const res = await fetch('/api/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: decodedCode })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error);
          if (data.files && data.files.length > 0) {
            resultArea.innerHTML = data.files.map(f => buildDownloadCard(f)).join('');
          } else {
            resultArea.innerHTML = `
              <div class="result-success">
                <div class="result-success-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="15" height="15"><polyline points="20,6 9,17 4,12"/></svg>
                </div>
                <div class="result-success-text">
                  <div class="title">Executado com sucesso</div>
                </div>
              </div>`;
          }
        }

        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><polygon points="5,3 19,12 5,21"/></svg> Gerar arquivo';
        btn.disabled = false;

      } catch (err) {
        resultArea.innerHTML = `<p class="run-error">Erro: ${err.message}</p>`;
        btn.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><polygon points="5,3 19,12 5,21"/></svg> Tentar novamente';
        btn.disabled = false;
      }
    });

    bubble.appendChild(codeBlock);
    lastIndex = match.index + match[0].length;
  }

  // Texto após o último bloco
  if (lastIndex < content.length) {
    const textNode = document.createElement('p');
    textNode.style.cssText = 'margin:0;white-space:pre-wrap;';
    textNode.textContent = content.slice(lastIndex);
    bubble.appendChild(textNode);
  }

  if (!hasCode) {
    bubble.textContent = content;
  }
}

function buildDownloadCard(f) {
  const ext = f.name.split('.').pop().toLowerCase();
  const types = {
    xlsx: { label: 'Excel',      cls: 'file-xlsx', icon: 'XLS' },
    xls:  { label: 'Excel',      cls: 'file-xlsx', icon: 'XLS' },
    pdf:  { label: 'PDF',        cls: 'file-pdf',  icon: 'PDF' },
    pptx: { label: 'PowerPoint', cls: 'file-pptx', icon: 'PPT' },
    ppt:  { label: 'PowerPoint', cls: 'file-pptx', icon: 'PPT' },
    docx: { label: 'Word',       cls: 'file-docx', icon: 'DOC' },
    doc:  { label: 'Word',       cls: 'file-docx', icon: 'DOC' },
  };
  const t = types[ext] || { label: ext.toUpperCase(), cls: 'file-default', icon: ext.slice(0,3).toUpperCase() };
  return `
    <div class="download-card">
      <div class="download-file-icon ${t.cls}">${t.icon}</div>
      <div class="download-info">
        <div class="download-filename">${f.name}</div>
        <div class="download-meta">${t.label} · ${formatSize(f.size)}</div>
      </div>
      <a href="${f.url}" download="${f.name}" class="download-action-btn">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13">
          <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          <polyline points="7,10 12,15 17,10"/>
          <line x1="12" y1="15" x2="12" y2="3"/>
        </svg>
        Baixar
      </a>
    </div>`;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── Messages ──
function addMessage(role, content, meta) {
  if (!meta && currentAgent) meta = getSquadMeta(currentAgent.squad);
  const messagesEl = document.getElementById('messages');

  const msg = document.createElement('div');
  msg.className = `msg ${role}`;

  const av = document.createElement('div');
  av.className = 'msg-av';
  if (role === 'user') {
    av.textContent = 'V';
  } else {
    av.className = `msg-av sq-${meta?.colorClass || 'default'}`;
    av.textContent = currentAgent ? getInitials(currentAgent.name) : 'A';
  }

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';

  if (role === 'assistant') {
    renderMessageContent(bubble, content);
  } else {
    bubble.textContent = content;
  }

  msg.appendChild(av);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  return bubble;
}

function addTyping() {
  const meta = getSquadMeta(currentAgent?.squad);
  const messagesEl = document.getElementById('messages');
  const msg = document.createElement('div');
  msg.className = 'msg assistant';
  msg.id = 'typing-msg';

  const av = document.createElement('div');
  av.className = `msg-av sq-${meta.colorClass}`;
  av.textContent = currentAgent ? getInitials(currentAgent.name) : 'A';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.innerHTML = '<div class="typing-dots"><span></span><span></span><span></span></div>';

  msg.appendChild(av);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return msg;
}

// ── Send ──
let isStreaming = false;

document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('userInput').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
document.getElementById('userInput').addEventListener('input', function() {
  this.style.height = 'auto';
  this.style.height = Math.min(this.scrollHeight, 140) + 'px';
});

async function sendMessage() {
  const input = document.getElementById('userInput');
  const sendBtn = document.getElementById('sendBtn');
  const text = input.value.trim();

  if (!text || isStreaming || !currentAgent) return;
  if (!apiKey) { alert('Configure sua chave da OpenAI antes de enviar mensagens.'); return; }

  input.value = '';
  input.style.height = 'auto';
  isStreaming = true;
  sendBtn.disabled = true;

  const meta = getSquadMeta(currentAgent.squad);
  addMessage('user', text, meta);
  messages.push({ role: 'user', content: text });
  saveConversation(currentAgent.id);

  const typing = addTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, systemPrompt: currentAgent.systemPrompt, apiKey, model: getModelForAgent(currentAgent) })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Erro na API');
    }

    typing.remove();
    const bubble = addMessage('assistant', '', meta);
    bubble.textContent = '';

    let fullContent = '';
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const messagesEl = document.getElementById('messages');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const lines = decoder.decode(value).split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') break;
        try {
          const parsed = JSON.parse(data);
          fullContent += parsed.content;
          // Durante streaming mostra texto simples
          bubble.textContent = fullContent;
          messagesEl.scrollTop = messagesEl.scrollHeight;
        } catch {}
      }
    }

    // Ao finalizar, re-renderiza com blocos de código e botões
    renderMessageContent(bubble, fullContent);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    messages.push({ role: 'assistant', content: fullContent });
    saveConversation(currentAgent.id);
  } catch (err) {
    typing.remove();
    addMessage('assistant', `Erro: ${err.message}`, meta);
  } finally {
    isStreaming = false;
    sendBtn.disabled = false;
    input.focus();
  }
}
