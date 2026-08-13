const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { ipcRenderer } = require('electron');
const actions = [
  ['Pods', 'kubectl get pods'], ['Services', 'kubectl get services'],
  ['Deployments', 'kubectl get deployments'], ['Events', 'kubectl get events --sort-by=.lastTimestamp'],
  ['Nodes (cluster)', 'kubectl get nodes'], ['Ferramentas', 'kubecli list'], ['Limpar terminal', 'clear'],
];

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

const terminal = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: 'Menlo, Monaco, monospace',
  fontSize: 14,
  lineHeight: 1.28,
  scrollback: 10000,
  theme: terminalTheme,
});
const fit = new FitAddon();
let commandRunning = false;
let currentSettings;
const themes = {
  midnight: { background: '#35435a', cursor: '#b7bdc7', selectionBackground: '#52627b' },
  light: { background: '#f4f5f7', cursor: '#20262f', selectionBackground: '#b9cbe3' },
  contrast: { background: '#000000', cursor: '#ffff00', selectionBackground: '#555555' },
};
terminal.loadAddon(fit);
terminal.open(document.getElementById('terminal'));
// Reaplica após o canvas ser criado: o xterm renderiza o fundo no próprio canvas.
terminal.options.theme = terminalTheme;

function applySettings(settings) {
  currentSettings = { ...settings };
  const theme = themes[settings.theme] || themes.midnight;
  terminal.options.theme = { ...terminalTheme, ...theme, foreground: settings.fontColor || (settings.theme === 'light' ? '#20262f' : '#f1f3f6') };
  terminal.options.fontFamily = settings.fontFamily;
  terminal.options.fontSize = Number(settings.fontSize);
  terminal.options.lineHeight = Number(settings.lineHeight);
  terminal.options.cursorStyle = settings.cursorStyle;
  terminal.options.cursorBlink = Boolean(settings.cursorBlink);
  terminal.options.scrollback = Number(settings.scrollback);
  document.body.dataset.theme = settings.theme;
  resize();
}

function openSettings() {
  const settings = currentSettings;
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

function resize() {
  fit.fit();
  ipcRenderer.send('terminal-resize', { cols: terminal.cols, rows: terminal.rows });
}

function sendCommand(command) {
  if (commandRunning) return;
  if (command === 'clear') {
    terminal.clear();
    terminal.scrollToBottom();
    return;
  }
  commandRunning = true;
  ipcRenderer.send('terminal-input', `${command}\r`);
}

function updateState() {
  ipcRenderer.invoke('get-kube-state').then(({ context, namespace }) => {
    document.getElementById('context').textContent = context;
    document.getElementById('namespace').textContent = namespace;
  });
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

terminal.attachCustomKeyEventHandler((event) => {
  if (!commandRunning) return true;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') return true;
  return false;
});

terminal.onData((data) => {
  if (commandRunning) {
    if (data === '\u0003') ipcRenderer.send('terminal-input', data);
    return;
  }
  if (data.includes('\r')) commandRunning = true;
  ipcRenderer.send('terminal-input', data);
});

ipcRenderer.on('terminal-data', (_event, data) => {
  terminal.write(data);
  if (commandRunning && data.includes('\u001b]777;KUBECLI_READY\u0007')) commandRunning = false;
  if (data.includes('\u001b]777;KUBECLI_READY\u0007')) updateState();
});
ipcRenderer.on('terminal-config', (_event, data) => {
  showConfig(data.kubeconfig);
  if (data.settings) applySettings(data.settings);
  commandRunning = false;
  resize();
});
ipcRenderer.on('terminal-exit', (_event, code) => terminal.write(`\r\n[processo encerrado: ${code}]\r\n`));
ipcRenderer.on('terminal-error', (_event, message) => terminal.write(`\r\n[erro ao iniciar terminal: ${message}]\r\n`));
window.addEventListener('resize', resize);

document.getElementById('choose').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('choose-kubeconfig');
  showConfig(result.kubeconfig);
});
document.getElementById('edit').addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('edit-kubeconfig');
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
document.querySelectorAll('#quick-menu [data-command]').forEach((button) => button.addEventListener('click', () => {
  sendCommand(button.dataset.command);
  document.getElementById('quick-menu').hidden = true;
}));
document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault();
    const palette = document.getElementById('command-palette');
    palette.hidden = !palette.hidden;
    if (!palette.hidden) { renderPalette(); document.getElementById('palette-input').focus(); }
  }
  if (event.key === 'Escape') closePalette();
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
document.getElementById('reset-settings').addEventListener('click', async () => {
  applySettings(await ipcRenderer.invoke('reset-settings'));
  openSettings();
});
setInterval(updateState, 1500);

resize();
updateState();
ipcRenderer.invoke('get-settings').then(applySettings);
