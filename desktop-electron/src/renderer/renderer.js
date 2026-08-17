const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { ipcRenderer } = require('electron');
const actions = [
  ['Pods', 'kubectl get pods'], ['Services', 'kubectl get services'],
  ['Deployments', 'kubectl get deployments'], ['Events', 'kubectl get events --sort-by=.lastTimestamp'],
  ['Nodes (cluster)', 'kubectl get nodes'], ['Ferramentas', 'kubecli list'], ['Limpar terminal', 'clear'],
];
const historyKey = 'kubecli-command-history';

const terminalTheme = {
  background: '#35435a',
  foreground: '#f1f3f6',
  cursor: '#b7bdc7',
  selectionBackground: '#52627b',
  black: '#35435a',
  brightBlack: '#697386',
  white: '#f1f3f6',
  brightWhite: '#ffffff',
};

const sessions = new Map();
let activeSessionId = 'main';
let currentSettings;
const defaultTabLabel = '~ — zsh — 120×30';
let commandHistory = loadCommandHistory();
let historySaveTimer = null;

function loadCommandHistory() {
  try {
    const value = JSON.parse(localStorage.getItem(historyKey) || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function scheduleHistorySave() {
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(() => {
    saveHistoryNow();
  }, 250);
}

function saveHistoryNow() {
  if (historySaveTimer) clearTimeout(historySaveTimer);
  historySaveTimer = null;
  localStorage.setItem(historyKey, JSON.stringify(commandHistory));
}

window.addEventListener('beforeunload', saveHistoryNow);
const themes = {
  midnight: { background: '#35435a', cursor: '#b7bdc7', selectionBackground: '#52627b' },
  light: { background: '#f4f5f7', cursor: '#20262f', selectionBackground: '#b9cbe3' },
  contrast: { background: '#000000', cursor: '#ffff00', selectionBackground: '#555555' },
};
function applySettings(settings) {
  currentSettings = { ...settings };
  const theme = themes[settings.theme] || themes.midnight;
  sessions.forEach(({ terminal }) => {
    terminal.options.theme = { ...terminalTheme, ...theme, foreground: settings.fontColor || (settings.theme === 'light' ? '#20262f' : '#f1f3f6') };
    terminal.options.fontFamily = settings.fontFamily;
    terminal.options.fontSize = Number(settings.fontSize);
    terminal.options.lineHeight = Number(settings.lineHeight);
    terminal.options.cursorStyle = settings.cursorStyle;
    terminal.options.cursorBlink = Boolean(settings.cursorBlink);
    terminal.options.scrollback = Number(settings.scrollback);
  });
  document.body.dataset.theme = settings.theme;
  resize();
}

function activeSession() { return sessions.get(activeSessionId); }

function resize() {
  const session = activeSession();
  if (!session) return;
  session.fit.fit();
  ipcRenderer.send('terminal-resize', { id: activeSessionId, cols: session.terminal.cols, rows: session.terminal.rows });
}

function renderTabs() {
  const tabs = document.getElementById('tabs');
  tabs.innerHTML = '';
  sessions.forEach((session, id) => {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = `terminal-tab${id === activeSessionId ? ' active' : ''}`;
    tab.dataset.tabId = id;
    tab.title = 'Duplo clique para renomear';
    tab.textContent = session.label;
    if (id !== 'main') {
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '×';
      close.title = 'Fechar aba';
      close.addEventListener('click', async (event) => {
        event.stopPropagation();
        await closeSession(id);
      });
      tab.appendChild(close);
    }
    tab.addEventListener('click', () => switchSession(id));
    tab.addEventListener('dblclick', (event) => {
      if (event.target.closest('.tab-close')) return;
      openAction('rename-tab', id);
    });
    tabs.appendChild(tab);
  });
  const addTab = document.createElement('button');
  addTab.type = 'button';
  addTab.className = 'tab-new';
  addTab.textContent = '+';
  addTab.title = 'Nova aba';
  addTab.addEventListener('click', () => openAction('new-tab'));
  tabs.appendChild(addTab);
}

function switchSession(id) {
  if (!sessions.has(id)) return;
  activeSessionId = id;
  sessions.forEach((session, sessionId) => {
    session.element.hidden = sessionId !== id;
  });
  renderTabs();
  resize();
  activeSession().terminal.focus();
  flushTerminalOutput(activeSession());
  showConfig(activeSession().kubeconfig);
  showAgent(activeSession().agentPath);
  renderState(activeSession().state);
  updateState(id);
}

function createSession(id, label, sessionKubeconfig = '') {
  if (sessions.has(id)) return sessions.get(id);
  const element = document.createElement('div');
  element.className = 'terminal-session';
  element.dataset.sessionId = id;
  document.getElementById('terminals').appendChild(element);
  const terminal = new Terminal({
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'Menlo, Monaco, monospace',
    fontSize: 14,
    lineHeight: 1.28,
    scrollback: 5000,
    theme: terminalTheme,
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  terminal.open(element);
  const session = {
    id, label, element, terminal, fit, kubeconfig: sessionKubeconfig, runtimeKubeconfig: sessionKubeconfig,
    commandRunning: false,
    interactiveCommand: false,
    continuationBuffer: '',
    outputBuffer: '',
    outputScheduled: false,
    state: { context: 'sem-contexto', namespace: 'default' },
    agentPath: null,
    aiSession: null,
  };
  sessions.set(id, session);
  function finishInteractiveCommand() {
    session.commandRunning = false;
    session.interactiveCommand = false;
    session.continuationBuffer = '';
  }
  terminal.attachCustomKeyEventHandler((event) => {
    if (session.commandRunning && session.interactiveCommand) {
      const key = event.key.toLowerCase();
      if (event.ctrlKey && event.shiftKey && key === 'q') {
        ipcRenderer.send('terminal-input', { id, data: 'exit\r' });
        finishInteractiveCommand();
        return false;
      }
      if (event.ctrlKey && key === 'd') {
        ipcRenderer.send('terminal-input', { id, data: '\u0004' });
        finishInteractiveCommand();
        return false;
      }
      if (event.ctrlKey && key === 'c') {
        ipcRenderer.send('terminal-input', { id, data: '\u0003' });
        return false;
      }
    }
    return true;
  });
  terminal.onData((data) => {
    // Control-C and Control-D must reach the PTY immediately. They are not
    // text input and must never wait for the multiline paste buffer.
    if (data === '\u0003' || data === '\u0004') {
      session.continuationBuffer = '';
      ipcRenderer.send('terminal-input', { id, data });
      if (data === '\u0004') finishInteractiveCommand();
      return;
    }
    // Preserve native interactive typing. Only hold a trailing backslash so a
    // paste split across PTY data events can still normalize `\\\n` correctly.
    session.continuationBuffer += data;
    const hasLineEnd = /\r|\n/.test(session.continuationBuffer);
    const waitingForContinuation = session.continuationBuffer.endsWith('\\');
    if (!hasLineEnd && waitingForContinuation) return;
    let terminalInput = session.continuationBuffer;
    session.continuationBuffer = '';
    // Match shell continuation semantics: backslash + newline disappears.
    terminalInput = terminalInput.replace(/\\(?:\r\n|\r|\n)/g, '');
    const exitingInteractive = session.interactiveCommand && /^(?:exit|logout)\s*$/i.test(terminalInput.trim());
    if (terminalInput.includes('\r') || terminalInput.includes('\n')) {
      session.commandRunning = true;
      session.interactiveCommand = isInteractiveCommand(terminalInput.trim());
    }
    ipcRenderer.send('terminal-input', { id, data: terminalInput });
    if (exitingInteractive) finishInteractiveCommand();
  });
  if (currentSettings) applySettings(currentSettings);
  renderTabs();
  return session;
}

function showAgent(agentPath) {
  const element = document.getElementById('agent-name');
  if (!element) return;
  element.textContent = agentPath ? agentPath.split('/').pop() : 'nenhum';
  element.title = agentPath || 'Nenhum AGENTS.md selecionado para esta aba';
}

function shellQuote(value) {
  return `'${String(value || '').replaceAll("'", "'\\''")}'`;
}

async function closeSession(id) {
  if (id === 'main' || !sessions.has(id)) return;
  const result = await ipcRenderer.invoke('close-terminal', id);
  if (result.code) return;
  const session = sessions.get(id);
  session.terminal.dispose();
  session.element.remove();
  sessions.delete(id);
  if (activeSessionId === id) activeSessionId = 'main';
  switchSession(activeSessionId);
}

async function createTab(label = '') {
  const id = `tab-${Date.now()}`;
  const tabLabel = label.trim() || defaultTabLabel;
  // Cada aba nova começa no ~/.kube/config; a seleção de outra aba não é herdada.
  createSession(id, tabLabel, '');
  await ipcRenderer.invoke('create-terminal', { id });
  switchSession(id);
}

function openSettings(selectedProfile = '') {
  const settings = currentSettings;
  const profileSelect = document.getElementById('setting-profile');
  profileSelect.innerHTML = '<option value="">Configurações atuais</option>';
  Object.keys(settings.profiles || {}).forEach((name) => {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    profileSelect.appendChild(option);
  });
  profileSelect.value = selectedProfile || settings.activeProfile || '';
  document.getElementById('setting-theme').value = settings.theme;
  document.getElementById('setting-font-color').value = settings.fontColor;
  document.getElementById('setting-font-family').value = settings.fontFamily;
  document.getElementById('setting-font-size').value = settings.fontSize;
  document.getElementById('font-size-output').textContent = `${settings.fontSize} px`;
  document.getElementById('setting-line-height').value = settings.lineHeight;
  document.getElementById('line-height-output').textContent = settings.lineHeight;
  document.getElementById('setting-cursor-style').value = settings.cursorStyle;
  document.getElementById('setting-cursor-blink').checked = settings.cursorBlink;
  document.getElementById('setting-scrollback').value = settings.scrollback;
  document.getElementById('settings-modal').hidden = false;
}
function showProfileStatus(result) {
  const status = document.getElementById('profile-status');
  status.textContent = result.message;
  status.dataset.status = result.code ? 'error' : 'success';
  status.hidden = false;
}

function sendCommand(command) {
  const session = activeSession();
  if (!session || session.commandRunning) return;
  if (command === 'clear') {
    session.terminal.clear();
    session.terminal.scrollToBottom();
    return;
  }
  commandHistory = [command, ...commandHistory.filter((item) => item !== command)].slice(0, 100);
  scheduleHistorySave();
  session.commandRunning = true;
  session.interactiveCommand = isInteractiveCommand(command);
  ipcRenderer.send('terminal-input', { id: activeSessionId, data: `${command}\r` });
}

function isInteractiveCommand(command) {
  return /(?:^|\s)(?:kubectl|k)\s+(?:edit\b|exec\b[\s\S]*(?:\s-i(?:t)?|\s--stdin\b)(?:\s|$)|port-forward\b)/.test(command)
    || /(?:^|\s)kubecli\s+exec\b/.test(command);
}

function renderHistory() {
  const list = document.getElementById('history-list');
  list.innerHTML = commandHistory.length
    ? commandHistory.map((command) => `<button class="history-item" data-command="${command.replaceAll('"', '&quot;')}">${command}</button>`).join('')
    : '<p class="history-empty">Nenhum comando executado ainda.</p>';
  list.querySelectorAll('[data-command]').forEach((item) => item.addEventListener('click', () => {
    sendCommand(item.dataset.command);
    document.getElementById('history-modal').hidden = true;
  }));
}

function openHistory() {
  renderHistory();
  document.getElementById('history-modal').hidden = false;
}

function updateState(id = activeSessionId) {
  const requestedId = id;
  ipcRenderer.invoke('get-kube-state', { id }).then((state) => {
    const session = sessions.get(requestedId);
    if (!session) return;
    session.state = state;
    if (requestedId === activeSessionId) renderState(state);
  });
}

function renderState(state) {
  document.getElementById('context').textContent = state?.context || 'sem-contexto';
  document.getElementById('namespace').textContent = state?.namespace || 'default';
}

function showConfig(path) {
  const name = path.split(/[\\/]/).pop() || path;
  const config = document.getElementById('config');
  config.textContent = name;
  config.title = path;
}

function renderPalette(filter = '') {
  const query = filter.toLowerCase();
  const results = actions.filter(([label, command]) => `${label} ${command}`.toLowerCase().includes(query));
  document.getElementById('palette-results').innerHTML = results.map(([label, command]) => `<div class="palette-item" data-command="${command}">${label}<span> — ${command}</span></div>`).join('');
  document.querySelectorAll('.palette-item').forEach((item) => item.addEventListener('click', () => { sendCommand(item.dataset.command); closePalette(); }));
}

function closePalette() { document.getElementById('command-palette').hidden = true; }

function closeOverlays() {
  ['quick-menu', 'kubeconfig-menu', 'command-palette', 'history-modal', 'action-modal', 'settings-modal', 'instructions-modal', 'kubeconfig-modal', 'ai-settings-modal', 'mcp-settings-modal']
    .forEach((id) => { const element = document.getElementById(id); if (element) element.hidden = true; });
  document.getElementById('kubeconfig-toggle')?.setAttribute('aria-expanded', 'false');
}

function queueTerminalOutput(id, data) {
  const session = sessions.get(id);
  if (!session) return;
  session.outputBuffer += data;
  if (id !== activeSessionId) return;
  if (session.outputScheduled) return;
  session.outputScheduled = true;
  requestAnimationFrame(() => {
    session.outputScheduled = false;
    const output = session.outputBuffer;
    session.outputBuffer = '';
    session.terminal.write(output);
    if (session.commandRunning && output.includes('\u001b]777;KUBECLI_READY\u0007')) {
      session.commandRunning = false;
      session.interactiveCommand = false;
    }
    if (output.includes('\u001b]777;KUBECLI_READY\u0007') && id === activeSessionId) updateState(id);
  });
}
function flushTerminalOutput(session) {
  if (!session?.outputBuffer) return;
  const output = session.outputBuffer;
  session.outputBuffer = '';
  session.terminal.write(output);
}
ipcRenderer.on('terminal-data', (_event, { id, data }) => queueTerminalOutput(id, data));
ipcRenderer.on('terminal-state', (_event, { id, state }) => {
  const session = sessions.get(id);
  if (!session) return;
  session.state = state;
  if (id === activeSessionId) renderState(state);
});
ipcRenderer.on('terminal-config', (_event, data) => {
  const session = createSession(data.id, defaultTabLabel, data.kubeconfig);
  session.kubeconfig = data.kubeconfig;
  session.runtimeKubeconfig = data.runtimeKubeconfig || data.kubeconfig;
  session.agentPath = data.agentPath || null;
  session.aiSession = data.aiSession || null;
  if (data.id === activeSessionId) {
    showConfig(data.kubeconfig);
    showAgent(session.agentPath);
  }
  if (data.settings) applySettings(data.settings);
  session.commandRunning = false;
  resize();
});
ipcRenderer.on('ai-config', (_event, data) => {
  const session = sessions.get(data.id);
  if (!session) return;
  session.agentPath = data.agentPath || null;
  if (data.id === activeSessionId) showAgent(session.agentPath);
});
ipcRenderer.on('terminal-exit', (_event, { id, code }) => sessions.get(id)?.terminal.write(`\r\n[processo encerrado: ${code}]\r\n`));
ipcRenderer.on('terminal-error', (_event, { id, message }) => sessions.get(id)?.terminal.write(`\r\n[erro ao iniciar terminal: ${message}]\r\n`));
ipcRenderer.on('menu-command', (_event, command) => {
  if (command?.type === 'command') {
    sendCommand(command.command);
    return;
  }
  if (command?.type === 'action') {
    openAction(command.action);
    return;
  }
  const controls = {
    ai: 'ai',
    'ai-settings': 'ai-settings',
    'mcp-settings': 'mcp-settings',
    quick: 'quick',
    history: 'history',
    settings: 'settings',
    instructions: 'instructions',
    'choose-kubeconfig': 'choose',
    'edit-kubeconfig': 'edit',
    'add-cluster': 'add-cluster',
    'remove-cluster': 'remove-cluster',
  };
  if (controls[command]) document.getElementById(controls[command])?.click();
  if (command === 'clear-history') {
    commandHistory = [];
    scheduleHistorySave();
    renderHistory();
  }
  if (command === 'new-tab') openAction('new-tab');
  if (command === 'close-tab') closeSession(activeSessionId);
  if (command === 'choose-agent') chooseAgent();
});
window.addEventListener('resize', resize);

document.getElementById('choose').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('choose-kubeconfig', { id: activeSessionId });
  showConfig(result.kubeconfig);
  updateState(activeSessionId);
});
async function chooseAgent() {
  const session = activeSession();
  if (!session) return false;
  const selected = await ipcRenderer.invoke('choose-agent', { id: activeSessionId });
  if (selected.error || !selected.agentPath) return false;
  session.agentPath = selected.agentPath;
  session.aiSession = selected.aiSession;
  showAgent(session.agentPath);
  return true;
}
document.getElementById('ai').addEventListener('click', async () => {
  const session = activeSession();
  if (!session) return;
  if (!session.agentPath && !await chooseAgent()) return;
  const request = window.prompt('Descreva o problema para o agente:');
  if (!request?.trim()) return;
  const state = session.state || {};
  const command = [
    'kubecli ai',
    '--session', shellQuote(session.aiSession),
    'ask', '--agent', shellQuote(session.agentPath),
    '--context', shellQuote(state.context || ''),
    '--namespace', shellQuote(state.namespace || 'default'),
    shellQuote(request.trim()),
  ].join(' ');
  sendCommand(command);
});
function renderAiSettings(settings) {
  const container = document.getElementById('ai-model-fields');
  container.innerHTML = '';
  (settings.models || []).forEach((model, index) => {
    const block = document.createElement('section');
    block.className = 'ai-model-block';
    block.innerHTML = `
      <h3>Modelo ${index + 1} ${model.tokenConfigured ? '· token configurado' : '· token ausente'}</h3>
      <div class="ai-model-grid">
        <label>Nome<input data-ai-field="name" value="${escapeHtml(model.name)}" autocomplete="off" /></label>
        <label>Provedor<input data-ai-field="provider" value="${escapeHtml(model.provider)}" placeholder="openai, anthropic ou ollama" autocomplete="off" /></label>
        <label>Modelo<input data-ai-field="model" value="${escapeHtml(model.model)}" autocomplete="off" /></label>
        <label>Variável da API<input data-ai-field="apiKeyEnv" value="${escapeHtml(model.apiKeyEnv)}" placeholder="OPENAI_API_KEY" autocomplete="off" /></label>
        <label>Endpoint<input data-ai-field="baseUrl" value="${escapeHtml(model.baseUrl)}" placeholder="opcional" autocomplete="off" /></label>
        <label>Novo token<input data-ai-field="token" type="password" placeholder="deixe vazio para manter o token salvo" autocomplete="new-password" /></label>
      </div>`;
    container.appendChild(block);
  });
}
function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
async function openAiSettings() {
  try {
    const settings = await ipcRenderer.invoke('get-ai-settings');
    renderAiSettings(settings);
    document.getElementById('ai-settings-result').hidden = true;
    document.getElementById('ai-settings-modal').hidden = false;
  } catch (error) { window.alert(`Não foi possível abrir a configuração de IA: ${error.message || error}`); }
}
document.getElementById('ai-settings').addEventListener('click', openAiSettings);
document.getElementById('close-ai-settings').addEventListener('click', () => { document.getElementById('ai-settings-modal').hidden = true; });
document.getElementById('ai-settings-modal').addEventListener('click', (event) => {
  if (event.target.id === 'ai-settings-modal') event.currentTarget.hidden = true;
});
document.getElementById('ai-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const models = [...document.querySelectorAll('.ai-model-block')].map((block) => {
    const result = {};
    block.querySelectorAll('[data-ai-field]').forEach((field) => { result[field.dataset.aiField] = field.value.trim(); });
    return result;
  });
  const result = await ipcRenderer.invoke('save-ai-settings', { models });
  const output = document.getElementById('ai-settings-result');
  output.textContent = result.code ? result.message : 'Configuração salva com segurança.';
  output.dataset.status = result.code ? 'error' : 'success';
  output.hidden = false;
  if (!result.code) setTimeout(() => { document.getElementById('ai-settings-modal').hidden = true; }, 700);
});
function renderMcpSettings(settings) {
  const container = document.getElementById('mcp-server-fields');
  container.innerHTML = '';
  const servers = settings.mcpServers?.length ? settings.mcpServers : [{ name: '', transport: 'stdio', command: '', args: '', url: '', enabled: true, envConfigured: false }];
  servers.forEach((server, index) => {
    const block = document.createElement('section');
    block.className = 'mcp-server-block';
    block.innerHTML = `
      <h3>Servidor MCP ${index + 1} ${server.envConfigured ? '· credenciais configuradas' : ''}</h3>
      <div class="ai-model-grid">
        <label>Nome<input data-mcp-field="name" value="${escapeHtml(server.name)}" placeholder="kubernetes" autocomplete="off" /></label>
        <label>Transporte<select data-mcp-field="transport"><option value="stdio" ${server.transport === 'stdio' ? 'selected' : ''}>stdio</option><option value="streamable_http" ${server.transport === 'streamable_http' ? 'selected' : ''}>streamable_http</option><option value="sse" ${server.transport === 'sse' ? 'selected' : ''}>sse</option></select></label>
        <label>Comando<input data-mcp-field="command" value="${escapeHtml(server.command)}" placeholder="npx" autocomplete="off" /></label>
        <label>Argumentos<input data-mcp-field="args" value="${escapeHtml(server.args)}" placeholder="-y servidor-mcp" autocomplete="off" /></label>
        <label>URL<input data-mcp-field="url" value="${escapeHtml(server.url)}" placeholder="http://localhost:3000/mcp" autocomplete="off" /></label>
        <label>Variáveis sensíveis (JSON)<input data-mcp-field="envJson" type="password" placeholder="deixe vazio para manter" autocomplete="new-password" /></label>
        <label class="check-row"><input data-mcp-field="enabled" type="checkbox" ${server.enabled !== false ? 'checked' : ''} /> Habilitado</label>
      </div>`;
    container.appendChild(block);
  });
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = 'Adicionar servidor';
  add.addEventListener('click', () => {
    const current = collectMcpSettings();
    current.push({ name: '', transport: 'stdio', command: '', args: '', url: '', enabled: true, envJson: '' });
    renderMcpSettings({ mcpServers: current });
  });
  container.appendChild(add);
}
function collectMcpSettings() {
  return [...document.querySelectorAll('.mcp-server-block')].map((block) => {
    const result = {};
    block.querySelectorAll('[data-mcp-field]').forEach((field) => { result[field.dataset.mcpField] = field.type === 'checkbox' ? field.checked : field.value.trim(); });
    return result;
  }).filter((server) => server.name || server.command || server.url);
}
async function openMcpSettings() {
  try {
    const settings = await ipcRenderer.invoke('get-ai-settings');
    renderMcpSettings(settings);
    document.getElementById('mcp-settings-result').hidden = true;
    document.getElementById('mcp-settings-modal').hidden = false;
  } catch (error) { window.alert(`Não foi possível abrir a configuração MCP: ${error.message || error}`); }
}
document.getElementById('mcp-settings').addEventListener('click', openMcpSettings);
document.getElementById('close-mcp-settings').addEventListener('click', () => { document.getElementById('mcp-settings-modal').hidden = true; });
document.getElementById('mcp-settings-modal').addEventListener('click', (event) => {
  if (event.target.id === 'mcp-settings-modal') event.currentTarget.hidden = true;
});
document.getElementById('mcp-settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const current = await ipcRenderer.invoke('get-ai-settings');
  const result = await ipcRenderer.invoke('save-ai-settings', { models: current.models, mcpServers: collectMcpSettings() });
  const output = document.getElementById('mcp-settings-result');
  output.textContent = result.code ? result.message : 'Servidores MCP salvos com segurança.';
  output.dataset.status = result.code ? 'error' : 'success';
  output.hidden = false;
  if (!result.code) setTimeout(() => { document.getElementById('mcp-settings-modal').hidden = true; }, 700);
});
document.getElementById('edit').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('edit-kubeconfig', { id: activeSessionId });
  showConfig(result.kubeconfig);
});
function closeKubeconfigMenu() {
  document.getElementById('kubeconfig-menu').hidden = true;
  document.getElementById('kubeconfig-toggle').setAttribute('aria-expanded', 'false');
}
function openKubeconfigForm(formId, title) {
  closeKubeconfigMenu();
  document.getElementById('kubeconfig-modal-title').textContent = title;
  document.getElementById('add-cluster-form').hidden = formId !== 'add-cluster-form';
  document.getElementById('remove-cluster-form').hidden = formId !== 'remove-cluster-form';
  document.getElementById('kubeconfig-result').hidden = true;
  document.getElementById(formId).reset();
  document.getElementById('kubeconfig-modal').hidden = false;
  document.querySelector(`#${formId} input`)?.focus();
}
document.getElementById('kubeconfig-toggle').addEventListener('click', (event) => {
  event.stopPropagation();
  const menu = document.getElementById('kubeconfig-menu');
  menu.hidden = !menu.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!menu.hidden));
});
document.getElementById('add-cluster').addEventListener('click', () => openKubeconfigForm('add-cluster-form', 'Adicionar cluster'));
document.getElementById('remove-cluster').addEventListener('click', () => openKubeconfigForm('remove-cluster-form', 'Remover cluster'));
document.getElementById('close-kubeconfig').addEventListener('click', () => { document.getElementById('kubeconfig-modal').hidden = true; });
document.getElementById('kubeconfig-modal').addEventListener('click', (event) => {
  if (event.target.id === 'kubeconfig-modal') event.currentTarget.hidden = true;
});
document.getElementById('add-cluster-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await ipcRenderer.invoke('add-kubeconfig-cluster', {
    name: document.getElementById('add-cluster-name').value.trim(),
    server: document.getElementById('add-cluster-server').value.trim(),
    token: document.getElementById('add-cluster-token').value.trim(),
  });
  showKubeconfigResult(result);
});
document.getElementById('remove-cluster-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await ipcRenderer.invoke('remove-kubeconfig-cluster', {
    name: document.getElementById('remove-cluster-name').value.trim(),
    removeUsers: document.getElementById('remove-cluster-users').checked,
  });
  showKubeconfigResult(result);
});
function showKubeconfigResult(result) {
  const output = document.getElementById('kubeconfig-result');
  output.textContent = result.message;
  output.dataset.status = result.code ? 'error' : 'success';
  output.hidden = false;
  if (!result.code) updateState();
}
document.getElementById('instructions').addEventListener('click', () => {
  document.getElementById('instructions-modal').hidden = false;
});
document.getElementById('close-instructions').addEventListener('click', () => {
  document.getElementById('instructions-modal').hidden = true;
});
document.getElementById('instructions-modal').addEventListener('click', (event) => {
  if (event.target.id === 'instructions-modal') event.currentTarget.hidden = true;
});
document.addEventListener('click', (event) => {
  if (!event.target.closest('.header-menu')) closeKubeconfigMenu();
});
document.getElementById('quick').addEventListener('click', () => {
  const menu = document.getElementById('quick-menu');
  menu.hidden = !menu.hidden;
});
document.getElementById('history').addEventListener('click', openHistory);
document.getElementById('close-history').addEventListener('click', () => { document.getElementById('history-modal').hidden = true; });
document.getElementById('history-modal').addEventListener('click', (event) => {
  if (event.target.id === 'history-modal') event.currentTarget.hidden = true;
});
document.getElementById('clear-history').addEventListener('click', () => {
  commandHistory = [];
  scheduleHistorySave();
  renderHistory();
});
const actionDefinitions = {
  logs: { title: 'Logs de pod', fields: ['target', 'extra'], command: (v) => `kubecli logs ${v.target}${v.extra}` },
  describe: { title: 'Describe de pod', fields: ['target', 'extra'], command: (v) => `kubecli describe ${v.target}${v.extra}` },
  'rollout-status': { title: 'Rollout status', fields: ['target', 'extra'], command: (v) => `kubectl rollout status ${v.target}${v.extra}` },
  'rollout-restart': { title: 'Rollout restart', fields: ['target', 'extra'], command: (v) => `kubectl rollout restart ${v.target}${v.extra}` },
  exec: { title: 'Entrar no pod', fields: ['target', 'command', 'extra'], command: (v) => `kubectl exec -it ${v.target} -- ${v.command || '/bin/sh'}${v.extra}` },
  'port-forward': { title: 'Port-forward', fields: ['target', 'local-port', 'remote-port', 'extra'], command: (v) => `kubectl port-forward ${v.target} ${v.localPort}:${v.remotePort}${v.extra}` },
  scale: { title: 'Escalar recurso', fields: ['target', 'replicas', 'extra'], command: (v) => `kubectl scale ${v.target} --replicas=${v.replicas}${v.extra}` },
  'yaml-edit': { title: 'Editar YAML', fields: ['target'], command: (v) => `kubectl edit ${v.target}` },
  'alias-add': { title: 'Cadastrar alias', fields: ['alias-name', 'alias-command', 'alias-args'], command: (v) => `kubecli aliases add ${v.aliasName} ${v.aliasCommand}${v.aliasArgs ? ` ${v.aliasArgs}` : ''}` },
  'alias-remove': { title: 'Remover alias', fields: ['alias-name'], command: (v) => `kubecli aliases remove ${v.aliasName}` },
  'new-tab': { title: 'Nova aba', fields: ['tab-name'], command: () => '' },
  'rename-tab': { title: 'Renomear aba', fields: ['tab-name'], command: () => '' },
};
function openAction(action, tabId = activeSessionId) {
  const definition = actionDefinitions[action];
  if (!definition) return;
  document.getElementById('action-title').textContent = definition.title;
  document.getElementById('action-form').dataset.action = action;
  document.getElementById('action-form').dataset.tabId = tabId;
  ['target', 'command', 'local-port', 'remote-port', 'replicas', 'extra', 'alias-name', 'alias-command', 'alias-args', 'tab-name'].forEach((field) => {
    const visible = definition.fields.includes(field);
    document.getElementById(`action-${field}-label`).hidden = !visible;
    const input = document.getElementById(`action-${field}`);
    if (input) input.required = visible && ['target', 'local-port', 'remote-port', 'replicas', 'alias-name', 'tab-name'].includes(field);
  });
  document.getElementById('action-form').reset();
  document.getElementById('action-command').value = '/bin/sh';
  if (action === 'rename-tab') {
    document.getElementById('action-tab-name').value = sessions.get(tabId)?.label || '';
  }
  document.getElementById('action-result').hidden = true;
  document.getElementById('action-modal').hidden = false;
  document.querySelector('#action-form label:not([hidden]) input, #action-form label:not([hidden]) select')?.focus();
}
document.querySelectorAll('#quick-menu [data-command]').forEach((button) => button.addEventListener('click', () => {
  sendCommand(button.dataset.command);
  document.getElementById('quick-menu').hidden = true;
}));
document.querySelectorAll('#quick-menu [data-action]').forEach((button) => button.addEventListener('click', () => {
  openAction(button.dataset.action);
  document.getElementById('quick-menu').hidden = true;
}));
document.getElementById('close-action').addEventListener('click', () => { document.getElementById('action-modal').hidden = true; });
document.getElementById('action-modal').addEventListener('click', (event) => {
  if (event.target.id === 'action-modal') event.currentTarget.hidden = true;
});
document.getElementById('action-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = (id) => document.getElementById(id).value.trim();
  const extra = value('action-extra');
  const definition = actionDefinitions[event.currentTarget.dataset.action];
  const action = event.currentTarget.dataset.action;
  const values = {
    target: value('action-target'),
    command: value('action-command'),
    localPort: value('action-local-port'),
    remotePort: value('action-remote-port'),
    replicas: value('action-replicas'),
    extra: extra ? ` ${extra}` : '',
    aliasName: value('action-alias-name'),
    aliasCommand: value('action-alias-command'),
    aliasArgs: value('action-alias-args'),
    tabName: value('action-tab-name'),
  };
  if (action === 'new-tab') {
    createTab(values.tabName);
    document.getElementById('action-modal').hidden = true;
    return;
  }
  if (action === 'rename-tab') {
    const session = sessions.get(event.currentTarget.dataset.tabId);
    if (session && values.tabName) {
      session.label = values.tabName;
      renderTabs();
    }
    document.getElementById('action-modal').hidden = true;
    return;
  }
  if (action === 'alias-add' || action === 'alias-remove') {
    const request = action === 'alias-add'
      ? ipcRenderer.invoke('save-alias', { name: values.aliasName, command: values.aliasCommand, args: values.aliasArgs })
      : ipcRenderer.invoke('remove-alias', { name: values.aliasName });
    request.then((result) => {
      const output = document.getElementById('action-result');
      output.textContent = result.message;
      output.dataset.status = result.code ? 'error' : 'success';
      output.hidden = false;
      if (!result.code) {
        const name = values.aliasName;
        const shellCommand = action === 'alias-add'
          ? `alias ${name}='kubecli ${name}'`
          : `unalias ${name} 2>/dev/null`;
        ipcRenderer.send('terminal-input', { id: activeSessionId, data: `${shellCommand}\r` });
      }
    }).catch((error) => {
      const output = document.getElementById('action-result');
      output.textContent = `Erro ao salvar alias: ${error}`;
      output.dataset.status = 'error';
      output.hidden = false;
    });
    return;
  }
  const command = definition.command(values);
  if (command.includes('undefined') || (definition.fields.includes('local-port') && (!value('action-local-port') || !value('action-remote-port')))) return;
  sendCommand(command);
  document.getElementById('action-modal').hidden = true;
});
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
    event.preventDefault();
    openAction('new-tab');
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'w') {
    event.preventDefault();
    closeSession(activeSessionId);
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'h') {
    event.preventDefault();
    openHistory();
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    const palette = document.getElementById('command-palette');
    palette.hidden = !palette.hidden;
    if (!palette.hidden) { renderPalette(); document.getElementById('palette-input').focus(); }
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    closeOverlays();
  }
});
document.getElementById('palette-input').addEventListener('input', (event) => renderPalette(event.target.value));
document.getElementById('settings').addEventListener('click', openSettings);
document.getElementById('close-settings').addEventListener('click', () => { document.getElementById('settings-modal').hidden = true; });
document.getElementById('settings-modal').addEventListener('click', (event) => {
  if (event.target.id === 'settings-modal') event.currentTarget.hidden = true;
});
document.getElementById('setting-font-size').addEventListener('input', (event) => {
  document.getElementById('font-size-output').textContent = `${event.target.value} px`;
});
document.getElementById('setting-line-height').addEventListener('input', (event) => {
  document.getElementById('line-height-output').textContent = event.target.value;
});
document.getElementById('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const next = {
    theme: document.getElementById('setting-theme').value,
    fontColor: document.getElementById('setting-font-color').value,
    fontFamily: document.getElementById('setting-font-family').value,
    fontSize: Number(document.getElementById('setting-font-size').value),
    lineHeight: Number(document.getElementById('setting-line-height').value),
    cursorStyle: document.getElementById('setting-cursor-style').value,
    cursorBlink: document.getElementById('setting-cursor-blink').checked,
    scrollback: Number(document.getElementById('setting-scrollback').value),
  };
  applySettings(await ipcRenderer.invoke('save-settings', next));
  document.getElementById('settings-modal').hidden = true;
});
document.getElementById('setting-profile').addEventListener('change', async (event) => {
  const profileName = event.target.value;
  if (!profileName) return;
  const result = await ipcRenderer.invoke('apply-profile', profileName);
  if (result.code) return showProfileStatus(result);
  const applied = { ...result.profile, profiles: result.settings.profiles };
  currentSettings = applied;
  applySettings(applied);
  showProfileStatus(result);
  openSettings(profileName);
});
document.getElementById('save-profile').addEventListener('click', async () => {
  const name = document.getElementById('setting-profile-name').value.trim();
  const profileSettings = {
    theme: document.getElementById('setting-theme').value,
    fontColor: document.getElementById('setting-font-color').value,
    fontFamily: document.getElementById('setting-font-family').value,
    fontSize: Number(document.getElementById('setting-font-size').value),
    lineHeight: Number(document.getElementById('setting-line-height').value),
    cursorStyle: document.getElementById('setting-cursor-style').value,
    cursorBlink: document.getElementById('setting-cursor-blink').checked,
    scrollback: Number(document.getElementById('setting-scrollback').value),
  };
  const result = await ipcRenderer.invoke('save-profile', { name, profileSettings });
  if (result.code) return showProfileStatus(result);
  currentSettings = result.settings;
  currentSettings.activeProfile = name;
  showProfileStatus(result);
  document.getElementById('setting-profile-name').value = '';
  openSettings(name);
});
document.getElementById('delete-profile').addEventListener('click', async () => {
  const name = document.getElementById('setting-profile').value;
  if (!name) return;
  const result = await ipcRenderer.invoke('delete-profile', name);
  if (result.code) return showProfileStatus(result);
  currentSettings = result.settings;
  currentSettings.activeProfile = '';
  showProfileStatus(result);
  openSettings();
});
document.getElementById('reset-settings').addEventListener('click', async () => {
  applySettings(await ipcRenderer.invoke('reset-settings'));
  openSettings();
});
setInterval(updateState, 1500);

createSession('main', 'Terminal 1');
resize();
updateState();
ipcRenderer.invoke('get-settings').then(applySettings);
