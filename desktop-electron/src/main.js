const { app, BrowserWindow, dialog, ipcMain, Menu, shell, safeStorage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pty = require('node-pty');
const { execFile, execFileSync } = require('child_process');

let win;
const sessions = new Map();
const defaultSettings = {
  theme: 'midnight',
  fontColor: '#f1f3f6',
  fontFamily: 'Menlo, Monaco, monospace',
  fontSize: 14,
  lineHeight: 1.28,
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
  profiles: {},
};
let settings = { ...defaultSettings };
// O padrão do app é sempre o kubeconfig do usuário.
// Outro arquivo só é usado quando escolhido explicitamente pela interface.
let kubeconfig = path.join(os.homedir(), '.kube', 'config');

function aiSessionPath(id) {
  return path.join(app.getPath('userData'), 'ai-sessions', `${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

function createSessionKubeconfig(id, source) {
  const target = path.join(app.getPath('temp'), `kubecli-${process.pid}-${id}.yaml`);
  try {
    fs.copyFileSync(source, target);
    return { path: target, temporary: true };
  } catch {
    return { path: source, temporary: false };
  }
}

function cleanupSession(session) {
  if (session?.outputTimer) clearTimeout(session.outputTimer);
  if (session?.stateRefreshTimer) clearTimeout(session.stateRefreshTimer);
  if (!session?.temporary) return;
  try { fs.unlinkSync(session.runtimeKubeconfig); } catch {}
}

function readSessionState(id) {
  const session = sessions.get(id);
  if (!session) return Promise.resolve({ context: 'sem-contexto', namespace: 'default' });
  const env = { ...process.env, KUBECONFIG: session.runtimeKubeconfig };
  return new Promise((resolve) => {
    execFile('kubectl', ['config', 'current-context'], { env }, (contextError, contextStdout) => {
      const context = contextError ? 'sem-contexto' : (contextStdout.trim() || 'sem-contexto');
      execFile('kubectl', ['config', 'view', '--minify', '-o', 'jsonpath={.contexts[0].context.namespace}'], { env }, (_namespaceError, namespaceStdout) => {
        resolve({ context, namespace: namespaceStdout?.trim() || 'default' });
      });
    });
  });
}

function publishSessionState(id) {
  const session = sessions.get(id);
  if (!session) return;
  if (session.stateRefreshTimer || session.stateRefreshInFlight) {
    session.stateRefreshPending = true;
    return;
  }
  session.stateRefreshTimer = setTimeout(() => {
    session.stateRefreshTimer = null;
    session.stateRefreshInFlight = true;
    readSessionState(id).then((state) => {
      const current = sessions.get(id);
      if (!current) return;
      if (!current.lastState || current.lastState.context !== state.context || current.lastState.namespace !== state.namespace) {
        current.lastState = state;
        win?.webContents.send('terminal-state', { id, state });
      }
    }).finally(() => {
      const current = sessions.get(id);
      if (!current) return;
      current.stateRefreshInFlight = false;
      if (current.stateRefreshPending) {
        current.stateRefreshPending = false;
        publishSessionState(id);
      }
    });
  }, 120);
}

function settingsPath() { return path.join(app.getPath('userData'), 'settings.json'); }
function legacyUserDataPath() { return path.join(app.getPath('appData'), 'kubecli-desktop'); }
function migrateLegacyUserData() {
  const current = app.getPath('userData');
  const legacy = legacyUserDataPath();
  if (current === legacy || !fs.existsSync(legacy)) return;
  fs.mkdirSync(current, { recursive: true });
  for (const filename of ['ai-settings.json', 'settings.json']) {
    const source = path.join(legacy, filename);
    const target = path.join(current, filename);
    if (fs.existsSync(source) && !fs.existsSync(target)) fs.copyFileSync(source, target);
  }
}
function loadSettings() {
  try { settings = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) }; } catch { settings = { ...defaultSettings }; }
}
function saveSettings() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}
function aiSettingsPath() { return path.join(app.getPath('userData'), 'ai-settings.json'); }
function aiCliConfigPath() { return path.join(app.getPath('userData'), 'ai-config.toml'); }
function sharedAiCliConfigPath() { return path.join(os.homedir(), '.config', 'kubecli', 'ai-config.toml'); }
const aiCredentialService = 'kubecli-ai';
function emptyAiSettings() {
  return { models: [1, 2, 3].map((order) => ({ order, name: `modelo-${order}`, provider: '', model: '', baseUrl: '', apiKeyEnv: '', token: '' })), mcpServers: [] };
}
function loadAiSettingsRaw() {
  try { return JSON.parse(fs.readFileSync(aiSettingsPath(), 'utf8')); } catch { return emptyAiSettings(); }
}
function publicAiSettings() {
  const raw = loadAiSettingsRaw();
  return { models: (raw.models || []).map((model, index) => ({
    order: model.order || index + 1,
    name: model.name || `modelo-${index + 1}`,
    provider: model.provider || '',
    model: model.model || '',
    baseUrl: model.baseUrl || '',
    apiKeyEnv: model.apiKeyEnv || '',
    tokenConfigured: Boolean(model.token),
    token: '',
  })), mcpServers: (raw.mcpServers || []).map((server, index) => ({
    name: server.name || `mcp-${index + 1}`,
    transport: server.transport || 'stdio',
    command: server.command || '',
    args: server.args || '',
    url: server.url || '',
    enabled: server.enabled !== false,
    envConfigured: Boolean(server.env),
    envJson: '',
  })) };
}
function decryptToken(value) {
  if (!value || !safeStorage.isEncryptionAvailable()) return '';
  try { return safeStorage.decryptString(Buffer.from(value, 'base64')); } catch { return ''; }
}
function aiEnvironment() {
  const env = {};
  const settings = loadAiSettingsRaw();
  for (const model of settings.models || []) {
    if (model.apiKeyEnv && model.token) env[model.apiKeyEnv] = decryptToken(model.token);
  }
  for (const server of settings.mcpServers || []) {
    if (!server.env) continue;
    try { Object.assign(env, JSON.parse(decryptToken(server.env) || '{}')); } catch {}
  }
  return env;
}
function saveKeychainCredential(account, value) {
  if (!account || !value) return;
  try {
    if (process.platform === 'darwin') {
      execFileSync('security', ['add-generic-password', '-a', account, '-s', aiCredentialService, '-w', value, '-U'], { stdio: 'ignore' });
    } else if (process.platform === 'linux') {
      execFileSync('secret-tool', ['store', '--label=KubeCLI AI credential', 'service', aiCredentialService, 'account', account], { input: value, stdio: ['pipe', 'ignore', 'ignore'] });
    }
  } catch {}
}
function tomlString(value) {
  return JSON.stringify(String(value || ''));
}
function normalizeMcpArgs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}
function modelCredentialAccount(index) { return `kubecli-ai-model-${index + 1}`; }
function syncAiCliConfig() {
  const raw = loadAiSettingsRaw();
  for (const [index, model] of (raw.models || []).entries()) {
    if (model.token) saveKeychainCredential(modelCredentialAccount(index), decryptToken(model.token));
  }
  const modelContent = (raw.models || []).filter((model) => model.provider && model.model).map((model, index) => [
    '[[models]]',
    `name = ${tomlString(model.name || `modelo-${index + 1}`)}`,
    `provider = ${tomlString(model.provider)}`,
    `model = ${tomlString(model.model)}`,
    `base_url = ${tomlString(model.baseUrl)}`,
    `api_key_env = ${tomlString(model.apiKeyEnv)}`,
    `credential_account = ${tomlString(modelCredentialAccount(index))}`,
    `order = ${index + 1}`,
    '',
  ].join('\n')).join('\n');
  const mcpContent = (raw.mcpServers || []).filter((server) => server.name && server.enabled !== false).map((server) => [
    '[[mcp.servers]]',
    `name = ${tomlString(server.name)}`,
    `transport = ${tomlString(server.transport || 'stdio')}`,
    `command = ${tomlString(server.command)}`,
    `args = ${JSON.stringify(normalizeMcpArgs(server.args))}`,
    `url = ${tomlString(server.url)}`,
    'enabled = true',
    '',
  ].join('\n')).join('\n');
  const content = `${modelContent}\n${mcpContent}`;
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(aiCliConfigPath(), content, { mode: 0o600 });
  fs.mkdirSync(path.dirname(sharedAiCliConfigPath()), { recursive: true });
  fs.writeFileSync(sharedAiCliConfigPath(), content, { mode: 0o600 });
}
function saveAiSettings(input) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('O armazenamento seguro do sistema não está disponível.');
  const previous = loadAiSettingsRaw();
  const models = (input.models || []).slice(0, 3).map((model, index) => {
    const old = previous.models?.[index] || {};
    let token = old.token || '';
    if (model.token) {
      const value = String(model.token);
      token = safeStorage.encryptString(value).toString('base64');
      saveKeychainCredential(modelCredentialAccount(index), value);
    } else if (old.token) {
      // Migra tokens já salvos no safeStorage para o Keychain compartilhado.
      const value = decryptToken(old.token);
      if (value) saveKeychainCredential(modelCredentialAccount(index), value);
    }
    return {
      order: index + 1,
      name: String(model.name || `modelo-${index + 1}`).trim(),
      provider: String(model.provider || '').trim(),
      model: String(model.model || '').trim(),
      baseUrl: String(model.baseUrl || '').trim(),
      apiKeyEnv: String(model.apiKeyEnv || '').trim(),
      token,
    };
  });
  const previousMcp = previous.mcpServers || [];
  const mcpServers = (input.mcpServers || []).filter((server) => server.name || server.command || server.url).map((server, index) => {
    const old = previousMcp[index] || {};
    let env = old.env || '';
    if (server.envJson) env = safeStorage.encryptString(String(server.envJson)).toString('base64');
    return {
      name: String(server.name || `mcp-${index + 1}`).trim(),
      transport: String(server.transport || 'stdio').trim(),
      command: String(server.command || '').trim(),
      args: Array.isArray(server.args) ? server.args.map((item) => String(item)).join(' ') : String(server.args || '').trim(),
      url: String(server.url || '').trim(),
      enabled: server.enabled !== false,
      env,
    };
  });
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(aiSettingsPath(), JSON.stringify({ models, mcpServers }, null, 2));
  syncAiCliConfig();
  return publicAiSettings();
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
    "alias kgp='kubectl get pods'",
    "alias kgn='kubectl get nodes'",
    "alias kctx='kubecli ctx list'",
    "alias kns='kubecli ns list'",
    "alias kdesc='kubectl describe'",
    "alias kl='kubectl logs'",
    "alias kevents='kubectl get events --sort-by=.lastTimestamp'",
    "alias kroll='kubectl rollout status'",
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
      "precmd() { printf '\\033]777;KUBECLI_READY\\007'; }",
      "PROMPT='%F{green}%n@%m%f %F{white}%U%~%u %#%f '",
      ...common,
    ].join(';') + ';\n';
  }
  return [
    "_kubecli_ready() { printf '\\033]777;KUBECLI_READY\\007'; }",
    "PROMPT_COMMAND=_kubecli_ready",
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
    title: 'K8sOps Terminal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: true,
    },
  });
  win.webContents.once('did-finish-load', () => startTerminal('main', kubeconfig));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => {
    sessions.forEach((session) => {
      session.pty.kill();
      cleanupSession(session);
    });
    sessions.clear();
    win = null;
  });
}

function sendMenuCommand(command) {
  win?.webContents.send('menu-command', command);
}

function showAbout() {
  dialog.showMessageBox(win, {
    type: 'info',
    title: 'Sobre o K8sOps',
    message: 'K8sOps',
    detail: `Terminal para operações Kubernetes\nVersão ${app.getVersion()}\nElectron ${process.versions.electron}\nNode.js ${process.versions.node}`,
  });
}

function createApplicationMenu() {
  const commandItem = (label, command) => ({ label, click: () => sendMenuCommand({ type: 'command', command }) });
  const actionItem = (label, action) => ({ label, click: () => sendMenuCommand({ type: 'action', action }) });
  const actionsMenu = [
    { label: 'Recursos', submenu: [
      commandItem('Pods', 'kubectl get pods'),
      commandItem('Services', 'kubectl get services'),
      commandItem('Deployments', 'kubectl get deployments'),
      commandItem('Events', 'kubectl get events --sort-by=.lastTimestamp'),
      commandItem('Nodes', 'kubectl get nodes'),
    ] },
    { label: 'Operações', submenu: [
      actionItem('Logs de pod', 'logs'),
      actionItem('Describe de pod', 'describe'),
      actionItem('Rollout status', 'rollout-status'),
      actionItem('Rollout restart', 'rollout-restart'),
      actionItem('Entrar no pod', 'exec'),
      actionItem('Port-forward', 'port-forward'),
      actionItem('Escalar recurso', 'scale'),
      actionItem('Editar YAML', 'yaml-edit'),
    ] },
    { label: 'Diagnóstico', submenu: [
      commandItem('Uso dos pods', 'kubectl top pods'),
      commandItem('Uso dos nodes', 'kubectl top nodes'),
      commandItem('Cluster info', 'kubectl cluster-info'),
      commandItem('Pods de todos namespaces', 'kubectl get pods -A'),
      commandItem('Eventos do cluster', 'kubectl get events -A --sort-by=.lastTimestamp'),
      commandItem('Permissões atuais', 'kubectl auth can-i --list'),
    ] },
    { label: 'Ferramentas', submenu: [
      actionItem('Cadastrar alias', 'alias-add'),
      actionItem('Remover alias', 'alias-remove'),
      commandItem('Ferramentas', 'kubecli list'),
      commandItem('Limpar terminal', 'clear'),
    ] },
    { label: 'Sessões', submenu: [actionItem('Nova aba', 'new-tab')] },
  ];
  const template = [
    {
      label: 'K8sOps',
      submenu: [
        { label: 'Sobre o K8sOps', click: showAbout },
        { type: 'separator' },
        { label: 'Configurações do terminal', click: () => sendMenuCommand('settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'K8s',
      submenu: [
        { label: 'Escolher kubeconfig…', click: () => sendMenuCommand('choose-kubeconfig') },
        { label: 'Editar kubeconfig', click: () => sendMenuCommand('edit-kubeconfig') },
        { type: 'separator' },
        { label: 'Adicionar cluster', click: () => sendMenuCommand('add-cluster') },
        { label: 'Remover cluster', click: () => sendMenuCommand('remove-cluster') },
      ],
    },
    {
      label: 'Operações',
      submenu: [
        ...actionsMenu,
        { type: 'separator' },
        { label: 'Nova aba', accelerator: 'CmdOrCtrl+T', click: () => sendMenuCommand({ type: 'action', action: 'new-tab' }) },
        { label: 'Fechar aba', accelerator: 'CmdOrCtrl+W', click: () => sendMenuCommand('close-tab') },
      ],
    },
    {
      label: 'Histórico',
      submenu: [
        { label: 'Abrir histórico', click: () => sendMenuCommand('history') },
        { label: 'Limpar histórico', click: () => sendMenuCommand('clear-history') },
      ],
    },
    {
      label: 'Configurações',
      submenu: [
        { label: 'Configurações do terminal', click: () => sendMenuCommand('settings') },
        { label: 'Instruções', click: () => sendMenuCommand('instructions') },
      ],
    },
    {
      label: 'IA',
      submenu: [
        { label: 'Escolher agente', click: () => sendMenuCommand('choose-agent') },
        { label: 'Iniciar troubleshooting com IA', click: () => sendMenuCommand('ai') },
        { label: 'Configurar modelos e APIs', click: () => sendMenuCommand('ai-settings') },
        { label: 'Configurar servidores MCP', click: () => sendMenuCommand('mcp-settings') },
      ],
    },
    {
      label: 'Editar',
      submenu: [
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Janela',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    {
      label: 'Ajuda',
      submenu: [{ label: 'Instruções do K8sOps', click: () => sendMenuCommand('instructions') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function startTerminal(id = 'main', sessionKubeconfig = kubeconfig) {
  if (process.platform === 'win32') {
    win?.webContents.send('terminal-error', { id, message: 'Esta versão suporta somente macOS e Linux.' });
    return;
  }
  const previous = sessions.get(id);
  if (previous) {
    previous.pty.kill();
    cleanupSession(previous);
    sessions.delete(id);
  }
  const isolated = createSessionKubeconfig(id, sessionKubeconfig);
  const shellPath = process.platform === 'darwin' ? '/bin/zsh' : (fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash');
  syncAiCliConfig();
  const env = {
    ...process.env,
    ...aiEnvironment(),
    KUBECLI_CONFIG: aiCliConfigPath(),
    KUBECLI_AI_SESSION: aiSessionPath(id),
    KUBECONFIG: isolated.path,
  };
  if (process.platform !== 'win32') env.TERM = 'xterm-256color';
  let session;
  try {
    session = pty.spawn(shellPath, ['-l'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      // O terminal inicia na pasta pessoal, como o Terminal.app do macOS.
      cwd: os.homedir(),
      env,
    });
  } catch (error) {
    win?.webContents.send('terminal-error', { id, message: String(error) });
    return;
  }
  sessions.set(id, {
    pty: session,
    kubeconfig: sessionKubeconfig,
    runtimeKubeconfig: isolated.path,
    temporary: isolated.temporary,
    agentPath: null,
    aiSession: aiSessionPath(id),
    outputBuffer: '',
    outputTimer: null,
    stateRefreshTimer: null,
    stateRefreshInFlight: false,
    stateRefreshPending: false,
    lastState: null,
  });
  session.write(shellInit(shellPath));
  session.onData((data) => {
    const output = String(data);
    const current = sessions.get(id);
    if (!current || current.pty !== session) return;
    current.outputBuffer += output;
    if (current.outputTimer) return;
    current.outputTimer = setTimeout(() => {
      current.outputTimer = null;
      if (sessions.get(id) !== current) return;
      const buffered = current.outputBuffer;
      current.outputBuffer = '';
      win?.webContents.send('terminal-data', { id, data: buffered });
      if (buffered.includes('\u001b]777;KUBECLI_READY\u0007')) publishSessionState(id);
    }, 8);
  });
  session.onExit(({ exitCode }) => {
    if (sessions.get(id)?.pty !== session) return;
    const finished = sessions.get(id);
    sessions.delete(id);
    cleanupSession(finished);
    win?.webContents.send('terminal-exit', { id, code: exitCode });
  });
  win.webContents.send('terminal-config', {
    id,
    kubeconfig: sessionKubeconfig,
    runtimeKubeconfig: isolated.path,
    settings,
    aiSession: aiSessionPath(id),
    agentPath: sessions.get(id)?.agentPath || null,
  });
  publishSessionState(id);
}

ipcMain.on('terminal-input', (_event, { id = 'main', data = '' } = {}) => sessions.get(id)?.pty.write(String(data)));
ipcMain.on('terminal-resize', (_event, { id = 'main', cols, rows } = {}) => {
  if (cols && rows) sessions.get(id)?.pty.resize(Number(cols), Number(rows));
});
ipcMain.on('terminal-stop', (_event, id = 'main') => sessions.get(id)?.pty.write('\u0003'));
ipcMain.handle('create-terminal', (_event, { id, kubeconfig: sessionKubeconfig } = {}) => {
  const tabId = id || `tab-${Date.now()}`;
  startTerminal(tabId, sessionKubeconfig || kubeconfig);
  return { id: tabId, kubeconfig: sessionKubeconfig || kubeconfig };
});
ipcMain.handle('close-terminal', (_event, id) => {
  if (!id || id === 'main') return { code: 1, message: 'A aba principal não pode ser fechada.' };
  const session = sessions.get(id);
  if (!session) return { code: 1, message: 'Sessão não encontrada.' };
  session.pty.kill();
  sessions.delete(id);
  cleanupSession(session);
  return { code: 0 };
});
ipcMain.handle('choose-kubeconfig', async (_event, { id = 'main' } = {}) => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Escolher kubeconfig',
    defaultPath: path.join(os.homedir(), '.kube'),
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) {
    return { kubeconfig: sessions.get(id)?.kubeconfig || kubeconfig };
  }
  const selectedKubeconfig = result.filePaths[0];
  if (id === 'main') kubeconfig = selectedKubeconfig;
  sessions.get(id)?.pty.kill();
  startTerminal(id, selectedKubeconfig);
  return { kubeconfig: selectedKubeconfig, id };
});
ipcMain.handle('edit-kubeconfig', async (_event, { id = 'main' } = {}) => {
  const currentKubeconfig = sessions.get(id)?.kubeconfig || kubeconfig;
  if (!fs.existsSync(currentKubeconfig)) fs.mkdirSync(path.dirname(currentKubeconfig), { recursive: true });
  if (!fs.existsSync(currentKubeconfig)) fs.writeFileSync(currentKubeconfig, '');
  await shell.openPath(currentKubeconfig);
  return { kubeconfig: currentKubeconfig, id };
});
ipcMain.handle('get-kubeconfig', (_event, { id = 'main' } = {}) => sessions.get(id)?.kubeconfig || kubeconfig);
ipcMain.handle('choose-agent', async (_event, { id = 'main' } = {}) => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Escolher AGENTS.md',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    filters: [{ name: 'Agente', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { id, agentPath: sessions.get(id)?.agentPath || null };
  const selected = result.filePaths[0];
  if (!path.basename(selected).toLowerCase().endsWith('agents.md')) {
    return { id, agentPath: null, error: 'Escolha um arquivo AGENTS.md.' };
  }
  const session = sessions.get(id);
  if (session) session.agentPath = selected;
  const shellPath = `'${selected.replaceAll("'", "'\\''")}'`;
  sessions.get(id)?.pty.write(`export KUBECLI_AI_AGENT=${shellPath}\n`);
  win?.webContents.send('ai-config', { id, agentPath: selected, aiSession: aiSessionPath(id) });
  return { id, agentPath: selected, aiSession: aiSessionPath(id) };
});
ipcMain.handle('get-ai-config', (_event, { id = 'main' } = {}) => {
  const session = sessions.get(id);
  return { id, agentPath: session?.agentPath || null, aiSession: aiSessionPath(id) };
});
ipcMain.handle('get-ai-settings', () => publicAiSettings());
ipcMain.handle('save-ai-settings', (_event, input) => {
  try { return { code: 0, settings: saveAiSettings(input || {}) }; }
  catch (error) { return { code: 1, message: String(error.message || error) }; }
});
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
ipcMain.handle('save-profile', (_event, { name, profileSettings = {} }) => {
  const profileName = String(name || '').trim();
  if (!profileName) return { code: 1, message: 'Informe um nome para o perfil.' };
  const { profiles = {}, ...visualSettings } = settings;
  const savedSettings = { ...visualSettings, ...profileSettings };
  delete savedSettings.profiles;
  settings.profiles = { ...profiles, [profileName]: savedSettings };
  saveSettings();
  return { code: 0, message: `Perfil '${profileName}' salvo.`, settings: { ...settings } };
});
ipcMain.handle('delete-profile', (_event, name) => {
  const profileName = String(name || '').trim();
  const profiles = { ...(settings.profiles || {}) };
  if (!profiles[profileName]) return { code: 1, message: 'Perfil não encontrado.' };
  delete profiles[profileName];
  settings.profiles = profiles;
  saveSettings();
  return { code: 0, message: `Perfil '${profileName}' removido.`, settings: { ...settings } };
});
ipcMain.handle('apply-profile', (_event, name) => {
  const profileName = String(name || '').trim();
  const profile = settings.profiles?.[profileName];
  if (!profile) return { code: 1, message: 'Perfil não encontrado.' };
  settings = { ...defaultSettings, ...settings, ...profile, profiles: settings.profiles };
  saveSettings();
  return {
    code: 0,
    message: `Perfil '${profileName}' aplicado.`,
    profile: { ...defaultSettings, ...profile },
    settings: { ...settings },
  };
});
ipcMain.handle('reset-settings', () => {
  settings = { ...defaultSettings };
  saveSettings();
  return { ...settings };
});
ipcMain.handle('get-kube-state', (_event, { id = 'main' } = {}) => readSessionState(id));

app.whenReady().then(() => { migrateLegacyUserData(); loadSettings(); createApplicationMenu(); createWindow(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
