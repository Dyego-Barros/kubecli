# K8sOps (Electron + xterm.js)

Esta é a versão desktop baseada em terminal real. Ela mantém a CLI Python como shell
e usa `node-pty` + `xterm.js` para preservar ANSI, prompts, `sudo`, `Ctrl+C`, histórico
e comandos interativos.

O shell iniciado pelo app usa `/bin/zsh` no macOS e zsh (ou Bash como fallback) no Linux.
Ele carrega atalhos equivalentes à CLI Python, como `k`, `get`, `pods`, `ctx`, `ns`,
`install` e `uninstall`. Esta versão é destinada somente a macOS e Linux.

## Instalar e executar

```bash
cd desktop-electron
npm install
npm start
```

## Gerar instaladores

No macOS, gere o `.dmg` com:

```bash
npm run dist:mac
```

Em Linux, gere os pacotes `.deb` e `.rpm` com:

```bash
npm run dist:linux
```

Os arquivos são criados na pasta `dist/`. O `.deb` é indicado para Debian/Ubuntu e o
`.rpm` para Fedora/RHEL/openSUSE. A compilação nativa do `node-pty` deve ser feita na
mesma plataforma do instalador.

O `npm install` recompila automaticamente `node-pty` para o ABI do Electron. Se as
dependências forem atualizadas manualmente, execute `npm run rebuild`.

O ícone personalizado fica em `assets/kubecli-icon.svg` e é usado nos instaladores.

Ao iniciar, usa `~/.kube/config`. Os botões permitem
selecionar outro kubeconfig e abri-lo no editor padrão.

O terminal inicia na pasta pessoal do usuário (`~`), e não dentro de `Resources` do aplicativo.

## Arquivos de configuração

No macOS, os arquivos do K8sOps ficam em:

```text
~/Library/Application Support/k8sops-desktop/
```

Arquivos principais:

- `ai-settings.json`: modelos, provedores, MCP e configurações criptografadas;
- `ai-config.toml`: configuração de IA usada pela CLI;
- `settings.json`: configurações visuais e perfis do terminal;
- `ai-sessions/`: sessões independentes de IA por aba.

Arquivos compartilhados com a CLI:

```text
~/.config/kubecli/ai-config.toml
~/.config/kubecli/aliases.json
~/.kube/config
```

Os tokens são protegidos pelo Keychain do macOS. Os kubeconfigs temporários das abas
são mantidos na pasta temporária do sistema e removidos ao fechar as sessões.

Após gerar os instaladores, é seguro remover artefatos temporários como `dist/mac-arm64/`,
`dist/linux-arm64-unpacked/` e arquivos `.blockmap`. Não remova `src/`, `assets/`,
`package.json` ou `node_modules/` se ainda pretende desenvolver ou gerar novos instaladores.
