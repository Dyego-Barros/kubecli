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
terminal.loadAddon(fit);
terminal.open(document.getElementById('terminal'));
// Reaplica após o canvas ser criado: o xterm renderiza o fundo no próprio canvas.
terminal.options.theme = terminalTheme;

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
document.getElementById('instructions').addEventListener('click', () => {
  document.getElementById('instructions-modal').hidden = false;
});
document.getElementById('close-instructions').addEventListener('click', () => {
  document.getElementById('instructions-modal').hidden = true;
});
document.getElementById('instructions-modal').addEventListener('click', (event) => {
  if (event.target.id === 'instructions-modal') event.currentTarget.hidden = true;
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
setInterval(updateState, 1500);

resize();
updateState();
