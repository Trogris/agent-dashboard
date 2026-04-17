let agents = [];
let currentAgent = null;
let messages = [];
let apiKey = localStorage.getItem('openai_key') || '';
let viewMode = 'grid';
let filterCategory = 'all';

// ── Notificacoes do browser ──
const NOTIFY_THRESHOLD_MS = 5000; // so notifica se demorou mais de 5s

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
}

function notifyDone(agentName, preview) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible') return; // so notifica se a aba estiver em segundo plano
  new Notification(`${agentName} respondeu`, {
    body: preview ? preview.slice(0, 100) : 'Resposta pronta.',
    icon: '/favicon.ico',
    silent: false
  });
}

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
  requestNotificationPermission();
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

// ── Toggle resposta em voz ──
function applyVoiceReply(enabled) {
  voiceReplyEnabled = enabled;
  localStorage.setItem('voiceReply', enabled);
  const btn = document.getElementById('voiceReplyBtn');
  btn.style.color = enabled ? '#635bff' : '';
  btn.style.borderColor = enabled ? '#635bff' : '';
  btn.title = enabled ? 'Respostas em audio (ativo)' : 'Respostas em audio';
}
applyVoiceReply(voiceReplyEnabled);
document.getElementById('voiceReplyBtn').addEventListener('click', () => {
  applyVoiceReply(!voiceReplyEnabled);
});

// ── Tema claro/escuro ──
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  document.getElementById('themeIconDark').style.display  = theme === 'light' ? 'none'  : 'block';
  document.getElementById('themeIconLight').style.display = theme === 'light' ? 'block' : 'none';
}

// Aplica tema salvo ou preferencia do sistema
const savedTheme = localStorage.getItem('theme') ||
  (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
applyTheme(savedTheme);

document.getElementById('themeBtn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'light' ? 'dark' : 'light');
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
  // Auto-salva memoria do agente anterior antes de trocar
  if (currentAgent && currentAgent.id !== agent.id && messages.length >= 4) {
    autoConsolidateMemory(currentAgent, [...messages]);
  }

  if (!meta) meta = getSquadMeta(agent.squad);
  lastSavedMessageCount = 0;
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
  const isOrch = agent.delegates && agent.delegates.length > 0;
  document.getElementById('chatAgentSquad').textContent =
    meta.label +
    (agent.title ? ` · ${agent.title}` : '') +
    ` · ${agentModel}` +
    (isOrch ? ` · Orquestrador (${agent.delegates.length} especialistas)` : '');

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

  // Oculta botoes de memoria — sera atualizado apos verificar status
  document.getElementById('memoryBadge').style.display = 'none';
  document.getElementById('consolidateBtn').style.display = 'none';
  loadMemoryStatus(agent.id);

  document.getElementById('userInput').focus();
}

// ── Close chat ──
document.getElementById('closeChat').addEventListener('click', () => {
  // Auto-salva memoria antes de fechar
  if (currentAgent && messages.length >= 4) {
    autoConsolidateMemory(currentAgent, [...messages]);
  }
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

// ── Converte markdown basico para HTML ──
function parseMarkdown(text) {
  return text
    .replace(/\*\*\*(.*?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.*?)__/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    .replace(/^#{1,6}\s+(.+)$/gm, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// ── Gera arquivo no browser a partir do bloco file-data ──
async function generateFileInBrowser(fileData) {
  const type = fileData.type;

  if (type === 'xlsx') {
    const wb = XLSX.utils.book_new();
    const sheets = fileData.sheets || [{ name: 'Dados', rows: fileData.rows || [] }];
    for (const sheet of sheets) {
      const ws = XLSX.utils.aoa_to_sheet(sheet.rows || []);
      XLSX.utils.book_append_sheet(wb, ws, sheet.name || 'Planilha');
    }
    XLSX.writeFile(wb, `${fileData.filename || 'arquivo'}.xlsx`);
    return;
  }

  if (type === 'pdf') {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
    const title = fileData.title || 'Relatorio';
    const sections = fileData.sections || [];

    doc.setFillColor(26, 26, 46);
    doc.rect(0, 0, 210, 22, 'F');
    doc.setFontSize(16); doc.setTextColor(255, 255, 255);
    doc.text(title, 14, 14);
    doc.setFontSize(8); doc.setTextColor(170, 170, 200);
    doc.text(new Date().toLocaleDateString('pt-BR'), 196, 14, { align: 'right' });

    let y = 30;
    doc.setTextColor(50, 50, 50);

    for (const section of sections) {
      if (y > 270) { doc.addPage(); y = 20; }

      if (section.title) {
        doc.setFontSize(13); doc.setFont(undefined, 'bold');
        doc.text(section.title, 14, y); y += 2;
        doc.setDrawColor(26, 26, 46); doc.setLineWidth(0.4);
        doc.line(14, y, 196, y); y += 6;
        doc.setFont(undefined, 'normal');
      }
      if (section.text) {
        doc.setFontSize(10);
        const lines = doc.splitTextToSize(section.text, 182);
        doc.text(lines, 14, y); y += lines.length * 5 + 4;
      }
      if (section.bullets) {
        doc.setFontSize(10);
        for (const b of section.bullets) {
          if (y > 270) { doc.addPage(); y = 20; }
          const lines = doc.splitTextToSize(`• ${b}`, 178);
          doc.text(lines, 18, y); y += lines.length * 5 + 2;
        }
        y += 2;
      }
      if (section.table && section.table.length > 0) {
        doc.autoTable({
          startY: y,
          head: [section.table[0]],
          body: section.table.slice(1),
          theme: 'striped',
          headStyles: { fillColor: [26, 26, 46], textColor: 255, fontSize: 9 },
          bodyStyles: { fontSize: 9 },
          margin: { left: 14, right: 14 }
        });
        y = doc.lastAutoTable.finalY + 8;
      }
    }
    doc.save(`${fileData.filename || 'relatorio'}.pdf`);
    return;
  }

  if (type === 'pptx') {
    const pptx = new PptxGenJS();
    pptx.layout = 'LAYOUT_16x9';
    const title = fileData.title || 'Apresentacao';

    const cover = pptx.addSlide();
    cover.background = { color: '1a1a2e' };
    cover.addText(title, { x: 0.5, y: 2.8, w: 9, h: 1.2, fontSize: 36, bold: true, color: 'FFFFFF', align: 'center' });
    if (fileData.subtitle) {
      cover.addText(fileData.subtitle, { x: 0.5, y: 4.1, w: 9, h: 0.6, fontSize: 16, color: 'AAAACC', align: 'center' });
    }

    for (const s of (fileData.slides || [])) {
      const slide = pptx.addSlide();
      slide.background = { color: 'FFFFFF' };
      slide.addText(s.title || '', { x: 0.4, y: 0.2, w: 9.2, h: 0.7, fontSize: 22, bold: true, color: '1a1a2e' });
      slide.addShape(pptx.ShapeType.rect, { x: 0.4, y: 0.95, w: 9.2, h: 0.04, fill: { color: '1a1a2e' } });

      if (s.bullets && s.bullets.length > 0) {
        slide.addText(s.bullets.map(b => ({ text: b, options: { bullet: true } })), {
          x: 0.6, y: 1.1, w: 8.8, h: 5, fontSize: 14, color: '333333', valign: 'top', paraSpaceAfter: 8
        });
      } else if (s.text) {
        slide.addText(s.text, { x: 0.6, y: 1.1, w: 8.8, h: 5, fontSize: 14, color: '333333', valign: 'top' });
      }
    }
    await pptx.writeFile({ fileName: `${fileData.filename || 'apresentacao'}.pptx` });
    return;
  }

  throw new Error(`Tipo nao suportado: ${type}`);
}

// ── Detecta e renderiza blocos de código com botão de execução ──
function renderMessageContent(bubble, content) {
  // Remove bloco file-data da exibicao
  content = content.replace(/```file-data[\s\S]*?```/gi, '').trim();

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

  // Texto apos o ultimo bloco
  if (lastIndex < content.length) {
    const textNode = document.createElement('p');
    textNode.style.cssText = 'margin:0;white-space:pre-wrap;';
    textNode.innerHTML = parseMarkdown(content.slice(lastIndex));
    bubble.appendChild(textNode);
  }

  if (!hasCode) {
    const p = document.createElement('p');
    p.style.cssText = 'margin:0;white-space:pre-wrap;';
    p.innerHTML = parseMarkdown(content);
    bubble.appendChild(p);
  }
}

// ── Detecta file-data na resposta e gera card de download ──
async function handleFileData(content, messagesEl) {
  const match = content.match(/```file-data\s*([\s\S]*?)```/i);
  if (!match) return;
  let fileData;
  try { fileData = JSON.parse(match[1].trim()); } catch { return; }

  const ext = fileData.type;
  const labels = { xlsx: 'Excel', pdf: 'PDF', pptx: 'PowerPoint' };
  const icons  = { xlsx: 'XLS',   pdf: 'PDF', pptx: 'PPT' };
  const cls    = { xlsx: 'file-xlsx', pdf: 'file-pdf', pptx: 'file-pptx' };

  const card = document.createElement('div');
  card.className = 'download-card';
  card.innerHTML = `
    <div class="download-file-icon ${cls[ext] || 'file-default'}">${icons[ext] || ext.toUpperCase()}</div>
    <div class="download-info">
      <div class="download-filename">${fileData.filename || 'arquivo'}.${ext}</div>
      <div class="download-meta">${labels[ext] || ext} · pronto para baixar</div>
    </div>
    <button class="download-action-btn" id="dlBtn_${Date.now()}">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13">
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
        <polyline points="7,10 12,15 17,10"/>
        <line x1="12" y1="15" x2="12" y2="3"/>
      </svg>
      Baixar
    </button>`;

  const btn = card.querySelector('button');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Gerando...';
    try {
      await generateFileInBrowser(fileData);
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="13" height="13"><polyline points="20,6 9,17 4,12"/></svg> Baixado`;
    } catch (e) {
      btn.textContent = 'Erro — tentar novamente';
      btn.disabled = false;
    }
  });

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'margin-top:10px;';
  wrapper.appendChild(card);

  const lastMsg = messagesEl.lastElementChild;
  if (lastMsg) lastMsg.querySelector('.msg-bubble')?.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
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

// ── Voz no browser ──
let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let voiceReplyEnabled = localStorage.getItem('voiceReply') === 'true';

async function playAudioResponse(text) {
  if (!voiceReplyEnabled) return;
  try {
    const voice = getVoiceForAgent(currentAgent);
    const clean = text
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]+`/g, '')
      .replace(/\*\*(.*?)\*\*/g, '$1')
      .replace(/\*(.*?)\*/g, '$1')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\n{2,}/g, ' ')
      .trim()
      .slice(0, 4000);
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: clean, voice, apiKey })
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.play();
  } catch {}
}

function getVoiceForAgent(agent) {
  if (!agent) return 'alloy';
  const voiceMap = {
    'geral':               'shimmer',
    'industrial':          'shimmer',
    'c-level-squad':       'onyx',
    'advisory-board':      'onyx',
    'hormozi-squad':       'onyx',
    'copy-master':         'fable',
    'copy-squad':          'fable',
    'storytelling':        'fable',
    'brand-squad':         'nova',
    'traffic-masters':     'echo',
    'data-squad':          'alloy',
    'design-squad':        'nova',
    'cybersecurity':       'echo',
    'claude-code-mastery': 'alloy',
    'movement':            'shimmer',
    'problem-solver-squad':'echo',
  };
  return voiceMap[agent.squad] || 'alloy';
}

const micBtn = document.getElementById('micBtn');

micBtn.addEventListener('click', async () => {
  if (isRecording) {
    // Para gravacao
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = e => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      isRecording = false;
      micBtn.classList.remove('recording');
      micBtn.disabled = true;
      stream.getTracks().forEach(t => t.stop());

      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      const formData = new FormData();
      formData.append('audio', blob, 'audio.webm');
      if (apiKey) formData.append('apiKey', apiKey);

      try {
        const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
        const data = await res.json();
        if (data.text) {
          document.getElementById('userInput').value = data.text;
          document.getElementById('userInput').dispatchEvent(new Event('input'));
          // Envia automaticamente
          sendMessage();
        }
      } catch (err) {
        console.error('Transcricao falhou:', err);
      } finally {
        micBtn.disabled = false;
      }
    };

    mediaRecorder.start();
    isRecording = true;
    micBtn.classList.add('recording');

    // Para automaticamente apos 60s
    setTimeout(() => { if (isRecording && mediaRecorder.state === 'recording') mediaRecorder.stop(); }, 60000);

  } catch (err) {
    alert('Permita acesso ao microfone para usar esta funcao.');
  }
});

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

  const agentNameSnap = currentAgent.name;
  const startedAt = Date.now();

  // Orquestradores usam /api/orchestrate; especialistas usam /api/chat
  const isOrchestrator = currentAgent.delegates && currentAgent.delegates.length > 0;

  if (isOrchestrator) {
    await sendMessageOrchestrate(meta);
  } else {
    await sendMessageChat(meta);
  }

  // Notifica se demorou mais do threshold e aba estava em segundo plano
  const elapsed = Date.now() - startedAt;
  if (elapsed >= NOTIFY_THRESHOLD_MS) {
    const lastMsg = messages[messages.length - 1];
    const preview = lastMsg?.role === 'assistant' ? lastMsg.content : '';
    notifyDone(agentNameSnap, preview);
  }

  isStreaming = false;
  sendBtn.disabled = false;
  document.getElementById('userInput').focus();

  // Auto-salva a cada 10 mensagens em background
  if (messages.length > 0 && messages.length % 10 === 0) {
    autoConsolidateMemory(currentAgent, [...messages]);
  }
}

// ── Memory ──
let lastSavedMessageCount = 0;

async function loadMemoryStatus(agentId) {
  try {
    const res = await fetch(`/api/memory/${agentId}`);
    const { hasMemory } = await res.json();
    document.getElementById('memoryBadge').style.display = hasMemory ? 'inline-flex' : 'none';
  } catch {}
}

// Consolidacao silenciosa em background — nao bloqueia UI
async function autoConsolidateMemory(agent, msgs) {
  if (!agent || msgs.length < 4) return; // minimo 2 trocas
  if (msgs.length <= lastSavedMessageCount) return; // nada novo
  try {
    const res = await fetch('/api/memory/consolidate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: msgs,
        agentId: agent.id,
        agentName: agent.name,
        apiKey
      })
    });
    const data = await res.json();
    if (data.success) {
      lastSavedMessageCount = msgs.length;
      document.getElementById('memoryBadge').style.display = 'inline-flex';
    }
  } catch {}
}

// Botao manual de salvar (opcional — para forcar salvamento imediato)
document.getElementById('consolidateBtn').addEventListener('click', async () => {
  if (!currentAgent || messages.length === 0) return;
  const btn = document.getElementById('consolidateBtn');
  const origHtml = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  await autoConsolidateMemory(currentAgent, [...messages]);
  btn.innerHTML = origHtml;
  btn.disabled = false;
});

async function sendMessageChat(meta) {
  const typing = addTyping();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, systemPrompt: currentAgent.systemPrompt, apiKey, model: getModelForAgent(currentAgent), agentId: currentAgent.id })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Erro na API');
    }

    typing.remove();
    const bubble = addMessage('assistant', '', meta);
    bubble.textContent = '';

    // Indicador de ferramenta (busca na web, leitura de pagina, etc.)
    const toolStatus = document.createElement('div');
    toolStatus.style.cssText = [
      'font-size:11px;color:var(--text3);margin-bottom:8px;padding:4px 10px;',
      'background:var(--surface2);border-radius:6px;display:none;',
      'border-left:2px solid rgba(99,91,255,.4);'
    ].join('');
    bubble.parentElement.insertBefore(toolStatus, bubble);

    const TOOL_LABELS = {
      buscar_na_web: q => `Buscando na web: "${q}"`,
      ler_pagina: u => `Lendo pagina: ${u}`,
    };

    let fullContent = '';
    let fileDetected = false;
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
          if (parsed.type === 'tool_use') {
            const labelFn = TOOL_LABELS[parsed.tool];
            const arg = parsed.args?.query || parsed.args?.url || parsed.tool;
            toolStatus.textContent = labelFn ? labelFn(arg) : `Usando ferramenta: ${parsed.tool}`;
            toolStatus.style.display = 'block';
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (parsed.content) {
            toolStatus.style.display = 'none';
            fullContent += parsed.content;

            // Detecta inicio do bloco file-data durante streaming
            if (!fileDetected && fullContent.includes('```file-data')) {
              fileDetected = true;
              const typeMatch = fullContent.match(/"type"\s*:\s*"(\w+)"/);
              const typeLabel = { xlsx: 'Excel', pdf: 'PDF', pptx: 'PowerPoint' }[typeMatch?.[1]] || 'arquivo';
              bubble.innerHTML = `<div class="file-generating">
                <div class="file-generating-spinner"></div>
                Gerando ${typeLabel}...
              </div>`;
            } else if (!fileDetected) {
              bubble.textContent = fullContent;
            }
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } catch {}
      }
    }

    toolStatus.remove();

    if (fileDetected) {
      bubble.innerHTML = '';
      await handleFileData(fullContent, messagesEl);
    } else {
      renderMessageContent(bubble, fullContent);
      await playAudioResponse(fullContent);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
    messages.push({ role: 'assistant', content: fullContent });
    saveConversation(currentAgent.id);
  } catch (err) {
    typing.remove();
    addMessage('assistant', `Erro: ${err.message}`, meta);
  }
}

async function sendMessageOrchestrate(meta) {
  const typing = addTyping();
  const messagesEl = document.getElementById('messages');

  // Status bar para mostrar delegações em andamento
  const statusEl = document.createElement('div');
  statusEl.style.cssText = [
    'font-size:11px;color:var(--text3);margin-top:8px;padding:5px 10px;',
    'background:var(--surface2);border-radius:6px;display:none;',
    'border-left:2px solid rgba(99,91,255,.4);'
  ].join('');
  typing.querySelector('.msg-bubble').appendChild(statusEl);

  let bubble = null;
  let fullContent = '';
  let fileDetected = false;

  try {
    const res = await fetch('/api/orchestrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages, agentId: currentAgent.id, apiKey })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Erro na orquestração');
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();

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
          if (parsed.type === 'delegation') {
            statusEl.style.display = 'block';
            statusEl.textContent = `Consultando ${parsed.agentName}...`;
          } else if (parsed.type === 'synthesis') {
            statusEl.textContent = 'Sintetizando analises dos especialistas...';
          } else if (parsed.type === 'content') {
            if (!bubble) {
              typing.remove();
              bubble = addMessage('assistant', '', meta);
              bubble.textContent = '';
            }
            fullContent += parsed.content;

            if (!fileDetected && fullContent.includes('```file-data')) {
              fileDetected = true;
              const typeMatch = fullContent.match(/"type"\s*:\s*"(\w+)"/);
              const typeLabel = { xlsx: 'Excel', pdf: 'PDF', pptx: 'PowerPoint' }[typeMatch?.[1]] || 'arquivo';
              bubble.innerHTML = `<div class="file-generating">
                <div class="file-generating-spinner"></div>
                Gerando ${typeLabel}...
              </div>`;
            } else if (!fileDetected) {
              bubble.textContent = fullContent;
            }
            messagesEl.scrollTop = messagesEl.scrollHeight;
          } else if (parsed.type === 'error') {
            throw new Error(parsed.error);
          }
        } catch (e) {
          if (e.message && !e.message.includes('JSON')) throw e;
        }
      }
    }

    if (bubble) {
      if (fileDetected) {
        bubble.innerHTML = '';
        await handleFileData(fullContent, messagesEl);
      } else {
        renderMessageContent(bubble, fullContent);
        await handleFileData(fullContent, messagesEl);
        await playAudioResponse(fullContent);
      }
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else {
      typing.remove();
    }
    messages.push({ role: 'assistant', content: fullContent });
    saveConversation(currentAgent.id);
  } catch (err) {
    typing.remove();
    addMessage('assistant', `Erro na orquestracao: ${err.message}`, meta);
  }
}
