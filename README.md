# KubeCLI

CLI para simplificar o trabalho diário com Kubernetes, OpenShift e provedores de
nuvem. O KubeCLI reúne atalhos para `kubectl`, `kubens`, `kubectx` e `oc`, além
de gerenciar ferramentas, aliases, kubeconfig e o prompt do shell.

Funciona em macOS e Linux.

## Instalação

Requisitos:

- Python 3.10 ou superior;
- [`uv`](https://docs.astral.sh/uv/);
- ferramentas que você pretende usar, como `kubectl`, `kubens`, `kubectx` ou `oc`.

Na raiz do projeto, instale a CLI em modo editável:

```bash
uv tool install --editable ./cli
```

Confirme a instalação:

```bash
kubecli --help
```

Durante o desenvolvimento, também é possível usar o ambiente virtual do projeto:

```bash
uv sync
uv run kubecli --help
```

## Uso rápido

```bash
# Contextos Kubernetes
kubecli ctx
kubecli ctx use meu-contexto

# Namespaces
kubecli ns
kubecli ns use monitoramento

# Atalhos para kubectl
kubecli k get pods
kubecli po -n monitoramento
kubecli svc -A
kubecli deploy -A
kubecli logs deploy/minha-aplicacao

# OpenShift
kubecli oc get projects
```

Os atalhos abaixo são equivalentes:

| KubeCLI | Comando executado |
| --- | --- |
| `kubecli k ...` ou `kubecli kc ...` | `kubectl ...` |
| `kubecli po ...` ou `kubecli pods ...` | `kubectl get pods ...` |
| `kubecli svc ...` | `kubectl get services ...` |
| `kubecli deploy ...` | `kubectl get deployments ...` |
| `kubecli x` | `kubectx` |
| `kubecli n ...` | `kubens ...` |

## Kubeconfig

Por padrão, o KubeCLI usa o kubeconfig selecionado pelo Kubernetes, normalmente:

```text
~/.kube/config
```

Para usar outro arquivo temporariamente:

```bash
KUBECONFIG=/caminho/para/kubeconfig kubecli ctx
```

Adicionar um cluster interativamente:

```bash
kubecli kubeconfig add
```

Remover um cluster e os contextos associados:

```bash
kubecli kubeconfig remove nome-do-cluster
```

Os comandos também aceitam a forma legada:

```bash
kubecli kubeconfig.add
kubecli kubeconfig.remove nome-do-cluster
```

Tokens e credenciais ficam no kubeconfig do usuário. Não versione arquivos de
kubeconfig, tokens ou secrets no Git.

## Prompt com contexto e namespace

Para mostrar o contexto e o namespace atuais automaticamente no prompt do shell:

### Zsh

Adicione ao `~/.zshrc`:

```bash
eval "$(kubecli shell-init zsh)"
```

Depois execute:

```bash
source ~/.zshrc
```

### Bash

Adicione ao `~/.bashrc`:

```bash
eval "$(kubecli shell-init bash)"
```

O estado atual também pode ser consultado diretamente:

```bash
kubecli prompt
```

## Ferramentas e instalações

Ver o sistema operacional, o gerenciador de pacotes e as versões disponíveis:

```bash
kubecli list
```

Verificar e instalar ferramentas ausentes:

```bash
kubecli setup
```

Instalar ou remover uma ferramenta específica:

```bash
kubecli install oc
kubecli uninstall oc
```

Para provedores de nuvem:

```bash
kubecli install azurecli
kubecli install awscli
kubecli install googlecli
```

O gerenciador de pacotes é detectado automaticamente. São suportados `brew`,
`apt`, `dnf`, `pacman`, `zypper`, `winget` e `choco`, conforme o sistema.
Operações de instalação e remoção pedem confirmação antes de executar.

## Aliases personalizados

Listar aliases disponíveis:

```bash
kubecli aliases
kubecli aliases list
```

Criar um alias:

```bash
kubecli aliases add meus-pods kubectl get pods -A
```

Remover um alias:

```bash
kubecli aliases remove meus-pods
```

Aliases personalizados são salvos em:

```text
~/.config/kubecli/aliases.json
```

## Cloud

O KubeCLI delega autenticação aos CLIs oficiais:

```bash
kubecli cloud login azurecli
kubecli cloud configure awscli
kubecli cloud login googlecli
kubecli cloud status awscli
```

As credenciais continuam sendo gerenciadas por `az`, `aws` e `gcloud`; o KubeCLI
não armazena tokens ou senhas desses provedores.

## Aplicativo desktop

O projeto também possui um terminal desktop baseado em Electron, com PTY real,
suporte ao kubeconfig padrão, seleção de outro kubeconfig, editor de configuração,
atalhos e instruções integradas.

Para executar durante o desenvolvimento:

```bash
cd desktop-electron
npm install
npm start
```

Para gerar o aplicativo macOS:

```bash
npm run dist:mac
```

Para gerar um pacote Debian no Linux:

```bash
npm run dist:deb
```

O aplicativo desktop usa o kubeconfig padrão em `~/.kube/config` ao iniciar.
O botão **Escolher kubeconfig** permite selecionar outro arquivo.

## Ajuda

## Troubleshooting com IA

A CLI permite selecionar um `AGENTS.md` por usuário e iniciar uma sessão de diagnóstico.
Os modelos configurados são usados em ordem: quando o primeiro atinge quota, limite ou
rate limit, a solicitação passa para o próximo, sem chamadas simultâneas.

Configure até três modelos em `~/.config/kubecli/config.toml`:

```toml
[[models]]
name = "principal"
provider = "openai"
model = "seu-modelo"
api_key_env = "OPENAI_API_KEY"
order = 1

[[models]]
name = "fallback"
provider = "anthropic"
model = "seu-modelo"
api_key_env = "ANTHROPIC_API_KEY"
order = 2
```

Comandos:

```bash
kubecli ai agents ~/kubecli-agents
kubecli ai list
# ou: kubecli ai models
kubecli ai start --agent ~/kubecli-agents/producao/AGENTS.md --context cluster-prod --namespace payments
kubecli ai ask "por que o deployment payments falhou?"
kubecli ai history
kubecli ai mcp list
```

Também é possível usar o executável curto `ai` depois de reinstalar a ferramenta:

```bash
ai list
ai start --agent ~/agentes/producao/AGENTS.md
ai ask "por que o deployment falhou?"
```

O fluxo usa LangGraph quando instalado, mantém o estado da sessão em
`~/.config/kubecli/ai-session.json` e aceita servidores MCP configurados no mesmo arquivo TOML.
No Electron, cada aba possui um arquivo de sessão separado e pode selecionar um `AGENTS.md`
independente, sem compartilhar agente, histórico ou consumo de modelos com as outras abas.
Para integrações externas, a sessão também pode ser definida explicitamente com
`kubecli ai --session /caminho/da/aba.json ...`.

As credenciais usam o armazenamento seguro do sistema: Keychain no macOS e Secret Service
(`secret-tool`/libsecret) no Linux. O Linux precisa ter o pacote `libsecret` com o comando
`secret-tool` disponível para que a CLI externa reutilize tokens cadastrados no desktop.

Todos os comandos possuem ajuda própria:

```bash
kubecli --help
kubecli ctx --help
kubecli ns --help
kubecli kubeconfig --help
kubecli aliases --help
kubecli cloud --help
kubecli install --help
```

## Estrutura do projeto

- [`cli/`](cli/): código da CLI Python e sua documentação detalhada;
- [`desktop-electron/`](desktop-electron/): aplicativo desktop Electron;
- `modules/`: módulos Terraform para OpenSearch e monitoramento;
- `helm/`: templates de valores Helm usados pelo Terraform.

## Infraestrutura Terraform

Além do KubeCLI, este repositório contém a infraestrutura do cluster de
monitoramento. Para utilizá-la:

```bash
cp terraform.tfvars.example terraform.tfvars
# edite as variáveis sensíveis

terraform init
terraform plan
terraform apply
```

As senhas e kubeconfigs devem ser mantidos fora do Git e em um gerenciador seguro
de secrets ou backend protegido do Terraform.
