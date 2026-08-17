# MCP no K8sOps

## O que é MCP

MCP (Model Context Protocol) conecta o K8sOps a servidores externos que expõem ferramentas, prompts ou recursos.

O MCP não é a LLM. O servidor fornece as capacidades e o K8sOps atua como cliente, descobrindo e chamando essas capacidades.

```text
K8sOps → conecta ao servidor MCP → descobre tools → chama uma tool → recebe o retorno
```

Uma tool pode consultar logs, métricas, incidentes, bancos de dados, APIs internas ou qualquer outro serviço que o servidor implemente.

## Fluxo no K8sOps

```bash
kubecli ai mcp list
```

Lista os servidores cadastrados.

```bash
kubecli ai mcp test
```

Faz o handshake com todos os servidores habilitados e lista as tools descobertas.

```bash
kubecli ai mcp test NOME_DO_SERVIDOR
```

Consulta somente um servidor específico.

```bash
kubecli ai mcp call SERVIDOR TOOL --arguments '{"campo":"valor"}'
```

Chama uma tool diretamente e imprime o retorno bruto.

```bash
kubecli ai mcp ask SERVIDOR TOOL --arguments '{"campo":"valor"}'
```

Chama a tool e envia somente o retorno para a LLM configurada formatar. Esse comando não carrega `AGENTS.md`, não executa `kubectl` e não inicia troubleshooting.

## Transporte `stdio`

No `stdio`, o K8sOps inicia o servidor MCP como um processo filho e conversa com ele por entrada e saída padrão.

```text
K8sOps inicia o processo
  ↓
handshake MCP pelos pipes stdin/stdout
  ↓
descoberta e chamada das tools
  ↓
processo encerra ao terminar a sessão
```

É adequado para servidores locais e scripts Python, Node ou executáveis.

Configuração:

```toml
[[mcp.servers]]
name = "example"
transport = "stdio"
command = "/Users/usuario/.local/bin/uv"
args = [
  "run",
  "--directory",
  "/caminho/do/projeto",
  "python",
  "mcp_example.py"
]
enabled = true
```

O campo `command` contém somente o executável. O campo `args` contém os argumentos posteriores. Não coloque `kubecli ai mcp test` nesses argumentos; esse é um comando do cliente usado para testar o servidor.

## Transporte `sse`

No `sse` (Server-Sent Events), o servidor fica executando em uma URL HTTP e envia eventos ao cliente por uma conexão SSE.

```text
K8sOps → URL SSE do servidor
       ← eventos e respostas MCP
```

Configuração:

```toml
[[mcp.servers]]
name = "observability"
transport = "sse"
url = "http://127.0.0.1:3000/sse"
enabled = true
```

Nesse modo o K8sOps não inicia o processo. O servidor precisa estar rodando antes da conexão.

SSE é útil para servidores HTTP existentes, mas é um transporte legado em comparação com `streamable_http`.

## Transporte `streamable_http`

No `streamable_http`, o servidor também fica executando separadamente, mas usa o transporte HTTP streamable do MCP, recomendado para novos servidores HTTP.

```text
Servidor MCP executando continuamente
        ↑↓ HTTP streamable
K8sOps conecta, descobre e chama tools
```

Configuração:

```toml
[[mcp.servers]]
name = "teste-http"
transport = "streamable_http"
url = "http://127.0.0.1:3000/mcp"
enabled = true
```

Nesse modo, `command` e `args` ficam vazios. O servidor deve ser iniciado em outro terminal ou serviço:

```bash
python mcp_http_example.py
```

Depois, o K8sOps conecta à URL:

```bash
kubecli ai mcp test teste-http
kubecli ai mcp call teste-http teste-http_hello_http \
  --arguments '{"name":"Dyego"}'
```

## Comparação rápida

| Transporte | Quem inicia o servidor? | Conexão | Uso típico |
|---|---|---|---|
| `stdio` | K8sOps | stdin/stdout | Servidor local |
| `sse` | Usuário/serviço externo | HTTP + SSE | Servidor HTTP legado |
| `streamable_http` | Usuário/serviço externo | HTTP streamable | Servidor HTTP recomendado |

## MCP e LLM

### Chamada direta

```bash
kubecli ai mcp call teste-http teste-http_hello_http \
  --arguments '{"name":"Dyego"}'
```

O resultado é retornado diretamente, sem LLM.

### Chamada com formatação da LLM

```bash
kubecli ai mcp ask teste-http teste-http_hello_http \
  --arguments '{"name":"Dyego"}'
```

A tool é executada primeiro. Depois, somente o resultado dela é enviado à LLM para formatação.

Isso é diferente de `kubecli ai ask`, que executa o fluxo completo do agente, incluindo `AGENTS.md`, contexto Kubernetes, `run_kubectl` e síntese de troubleshooting.
