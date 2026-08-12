const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { execFile } = require('child_process');

let win;
let terminal;
// O padrão do app é sempre o kubeconfig do usuário.
// Outro arquivo só é usado quando escolhido explicitamente pela interface.
let kubeconfig = path.join(os.homedir(), '.kube', 'config');

function shellInit(shellPath) {
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
  win.webContents.send('terminal-config', { kubeconfig });
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

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
