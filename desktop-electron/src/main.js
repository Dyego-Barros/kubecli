const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { execFile } = require('child_process');

let win;
let terminal;
const defaultSettings = {
  theme: 'midnight',
  fontColor: '#f1f3f6',
  fontFamily: 'Menlo, Monaco, monospace',
  fontSize: 14,
  lineHeight: 1.28,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
};
let settings = { ...defaultSettings };
// O padrão do app é sempre o kubeconfig do usuário.
// Outro arquivo só é usado quando escolhido explicitamente pela interface.
let kubeconfig = path.join(os.homedir(), '.kube', 'config');

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try { settings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch { settings = { ...defaultSettings }; }
}
function saveSettings() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}
function aliasesPath() { return path.join(os.homedir(), '.config', 'kubecli', 'aliases.json'); }
function readCustomAliases() {
  try { return JSON.parse(fs.readFileSync(aliasesPath(), 'utf8')); } catch { return {}; }
}
function writeCustomAliases(aliases) {
  fs.mkdirSync(path.dirname(aliasesPath()), { recursive: true });
  fs.writeFileSync(aliasesPath(), JSON.stringify(aliases, null, 2) + '\n');
}

function shellInit(shellPath) {
  const customAliases = Object.keys(readCustomAliases())
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))
    .map((name) => `alias ${name}='kubecli ${name}'`);
  const common = [
    "alias k='kubectl'",
    "alias kc='kubectl'",
    "alias get='kubectl get'",
    "alias pods='kubectl get pods'",
    "alias po='kubectl get pods'",
    "alias svc='kubectl get services'",
    "alias deploy='kubectl get deployments'",
    "alias nodes='kubectl get nodes'",
    "alias ctx='kubecli ctx'",
    "alias ns='kubecli ns'",
    "alias x='kubecli ctx'",
    "alias n='kubecli ns'",
    "alias install='kubecli install'",
    "alias uninstall='kubecli uninstall'",
    "alias kubeconfig='kubecli kubeconfig'",
    ...customAliases,
    "clear",
  ];
  if (shellPath.endsWith('/zsh')) {
    return [
      "autoload -U colors && colors",
      "setopt prompt_subst",
      "precmd() { print; print -Pn '\\e]777;KUBECLI_READY\\a'; }",
      "PROMPT='%F{green}%n@%m%f %F{white}%U%~%u %#%f '",
      ...common,
    ].join(';') + ';\n';
  }
  return [
    "PROMPT_COMMAND='printf \\\"\\n\\e]777;KUBECLI_READY\\a\\\"'",
    "PS1='\\033[32m\\u@\\h\\033[0m \\033[37m\\033[4m\\w\\033[24m\\033[0m \\$ '",
    ...common,
  ].join(';') + ';\n';
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 760,
    minHeight: 460,
    backgroundColor: '#35435a',
    title: 'KubeCLI Terminal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  win.webContents.once('did-finish-load', startTerminal);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('resize', () => win.webContents.send('terminal-resize'));
  win.on('closed', () => { if (terminal) terminal.kill(); win = null; });
}

function startTerminal() {
  if (process.platform === 'win32') {
    win?.webContents.send('terminal-error', 'Esta versão suporta somente macOS e Linux.');
    return;
  }
  const shellPath = process.platform === 'darwin' ? '/bin/zsh' : (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  if (process.platform !== 'win32') env.TERM = 'xterm-256color';
  try {
    terminal = pty.spawn(shellPath, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      // O terminal inicia na pasta pessoal, como o Terminal.app do macOS.
      cwd: os.homedir(),
      env,
    });
  } catch (error) {
    win?.webContents.send('terminal-error', String(error));
    return;
  }
  terminal.write(shellInit(shellPath));
  terminal.onData((data) => win?.webContents.send('terminal-data', data));
  terminal.onExit(({ exitCode }) => win?.webContents.send('terminal-exit', exitCode));
  win.webContents.send('terminal-config', { kubeconfig, settings });
}

ipcMain.on('terminal-input', (_event, data) => terminal?.write(data));
ipcMain.on('terminal-resize', (_event, { cols, rows }) => terminal?.resize(cols, rows));
ipcMain.handle('choose-kubeconfig', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Escolher kubeconfig',
    defaultPath: path.join(os.homedir(), '.kube'),
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return { kubeconfig };
  kubeconfig = result.filePaths[0];
  if (terminal) terminal.kill();
  startTerminal();
  return { kubeconfig };
});
ipcMain.handle('edit-kubeconfig', async () => {
  if (!fs.existsSync(kubeconfig)) fs.mkdirSync(path.dirname(kubeconfig), { recursive: true });
  if (!fs.existsSync(kubeconfig)) fs.writeFileSync(kubeconfig, '');
  await shell.openPath(kubeconfig);
  return { kubeconfig };
});
ipcMain.handle('get-kubeconfig', () => kubeconfig);
ipcMain.handle('save-alias', (_event, { name, command, args }) => {
  const aliasName = String(name || '').trim();
  const baseCommand = String(command || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(aliasName)) return { code: 1, message: 'Nome de alias inválido.' };
  if (['aliases', 'cloud', 'kubeconfig', 'kubectl', 'kubens', 'kubectx', 'oc'].includes(aliasName)) return { code: 1, message: 'Esse nome é reservado.' };
  if (!['kubectl', 'kubecli', 'kubens', 'kubectx', 'oc'].includes(baseCommand)) return { code: 1, message: 'Comando base inválido.' };
  const aliases = readCustomAliases();
  aliases[aliasName] = { command: baseCommand, args: String(args || '').trim().split(/\s+/).filter(Boolean) };
  writeCustomAliases(aliases);
  return { code: 0, message: `Alias '${aliasName}' cadastrado.` };
});
ipcMain.handle('remove-alias', (_event, { name }) => {
  const aliasName = String(name || '').trim();
  const aliases = readCustomAliases();
  if (!Object.prototype.hasOwnProperty.call(aliases, aliasName)) return { code: 1, message: `Alias '${aliasName}' não encontrado.` };
  delete aliases[aliasName];
  writeCustomAliases(aliases);
  return { code: 0, message: `Alias '${aliasName}' removido.` };
});
function runKubectl(args) {
  return new Promise((resolve) => {
    const env = { ...process.env, KUBECONFIG: kubeconfig };
    execFile('kubectl', args, { env }, (error, stdout, stderr) => resolve({
      code: error?.code || 0,
      stdout: stdout?.trim() || '',
      stderr: stderr?.trim() || '',
    }));
  });
}
ipcMain.handle('add-kubeconfig-cluster', async (_event, { name, server, token }) => {
  if (!name || !server || !token) return { code: 1, message: 'Nome, servidor e token são obrigatórios.' };
  const user = `kubecli-${name}`;
  const commands = [
    ['config', 'set-cluster', name, `--server=${server}`],
    ['config', 'set-credentials', user, `--token=${token}`],
    ['config', 'set-context', name, `--cluster=${name}`, `--user=${user}`, '--namespace=default'],
    ['config', 'use-context', name],
  ];
  for (const args of commands) {
    const result = await runKubectl(args);
    if (result.code) return { code: result.code, message: result.stderr || `Falha ao executar kubectl ${args.join(' ')}` };
  }
  return { code: 0, message: `Cluster '${name}' adicionado e selecionado.` };
});
ipcMain.handle('remove-kubeconfig-cluster', async (_event, { name, removeUsers }) => {
  if (!name) return { code: 1, message: 'Nome do cluster é obrigatório.' };
  const view = await runKubectl(['config', 'view', '--output=json']);
  if (view.code) return { code: view.code, message: view.stderr || 'Não foi possível ler o kubeconfig.' };
  let config;
  try { config = JSON.parse(view.stdout); } catch { return { code: 1, message: 'O kubeconfig não retornou JSON válido.' }; }
  const contexts = (config.contexts || []).filter((item) => item.context?.cluster === name);
  const users = [...new Set(contexts.map((item) => item.context?.user).filter(Boolean))];
  if (!(config.clusters || []).some((item) => item.name === name)) return { code: 1, message: `Cluster '${name}' não encontrado.` };
  for (const context of contexts) {
    const result = await runKubectl(['config', 'delete-context', context.name]);
    if (result.code) return { code: result.code, message: result.stderr || 'Falha ao remover o contexto.' };
  }
  const cluster = await runKubectl(['config', 'delete-cluster', name]);
  if (cluster.code) return { code: cluster.code, message: cluster.stderr || 'Falha ao remover o cluster.' };
  if (removeUsers) {
    for (const user of users) {
      const result = await runKubectl(['config', 'unset', `users.${user}`]);
      if (result.code) return { code: result.code, message: result.stderr || 'Falha ao remover usuário associado.' };
    }
  }
  return { code: 0, message: `Cluster '${name}' removido.` };
});
ipcMain.handle('get-settings', () => ({ ...settings }));
ipcMain.handle('save-settings', (_event, nextSettings) => {
  settings = { ...defaultSettings, ...settings, ...nextSettings };
  saveSettings();
  return { ...settings };
});
ipcMain.handle('reset-settings', () => {
  settings = { ...defaultSettings };
  saveSettings();
  return { ...settings };
});
ipcMain.handle('get-kube-state', () => new Promise((resolve) => {
  const env = { ...process.env, KUBECONFIG: kubeconfig };
  const shellPath = process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  execFile(shellPath, ['-lc', 'kubectl config current-context'], { env }, (contextError, contextStdout) => {
    const context = contextError ? 'sem-contexto' : (contextStdout.trim() || 'sem-contexto');
    execFile(shellPath, ['-lc', "kubectl config view --minify -o jsonpath='{.contexts[0].context.namespace}'"], { env }, (_namespaceError, namespaceStdout) => {
      resolve({ context, namespace: namespaceStdout?.trim() || 'default' });
    });
  });
}));

app.whenReady().then(() => { loadSettings(); createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
