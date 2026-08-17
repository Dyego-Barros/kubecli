# IA e MCP no K8sOps

Este guia explica como usar agentes e servidores MCP no K8sOps. Os dois recursos são relacionados, mas têm funções diferentes:

```text
Agente = instruções que orientam a LLM
MCP    = conexão com ferramentas externas
```

## 1. Pré-requisitos

Verifique se a CLI está disponível:

```bash
kubecli --help
ai --help
```

O comando `ai` é a forma curta de acessar os comandos de IA. Os comandos abaixo também podem ser escritos com `kubecli ai`.

Exemplo equivalente:

```bash
ai mcp list
kubecli ai mcp list
```

## 2. Agentes `AGENTS.md`

Um agente é um arquivo `AGENTS.md` com instruções para a LLM. Essas instruções podem definir:

- objetivo do agente;
- regras de diagnóstico;
- ferramentas que ele deve usar;
- formato da resposta;
- limites e cuidados operacionais.

O arquivo precisa ter exatamente o nome `AGENTS.md`.

### 2.1 Listar agentes

Para procurar agentes dentro de uma pasta:

```bash
ai agents ~/meus-agentes
```

O comando apenas lista os caminhos encontrados. Ele ainda não inicia nenhum agente.

Exemplo de resultado:

```text
/Users/usuario/meus-agentes/producao/AGENTS.md
/Users/usuario/meus-agentes/desenvolvimento/AGENTS.md
```

### 2.2 Iniciar uma sessão

Escolha um dos caminhos retornados e inicie a sessão:

```bash
ai start \
  --agent ~/meus-agentes/producao/AGENTS.md \
  --context cluster-producao \
  --namespace pagamentos
```

O parâmetro `--agent` recebe o caminho real do arquivo. `AGENTS.md` no exemplo abaixo é apenas um placeholder; não deve ser digitado literalmente se o arquivo estiver em outra pasta.

Se o contexto e o namespace não forem informados, o K8sOps tenta detectar os valores atuais do `kubectl`.

### 2.3 Fazer perguntas ao agente

Depois de iniciar a sessão:

```bash
ai ask "Verifique os pods com falha no namespace pagamentos"
```

O agente usa:

1. as instruções do `AGENTS.md`;
2. o contexto Kubernetes da sessão;
3. o namespace da sessão;
4. `run_kubectl` para coletar evidências;
5. as tools MCP habilitadas.

Comandos de leitura podem ser executados automaticamente. Comandos modificadores exigem confirmação no terminal.

### 2.4 Consultar a sessão

```bash
ai history
```

Exibe o agente, o contexto, o namespace, os modelos utilizados e a última resposta.

## 3. O que é MCP

MCP (Model Context Protocol) é o protocolo que conecta o K8sOps a servidores externos que fornecem tools, prompts ou recursos.

```text
K8sOps → conecta ao servidor MCP
       → descobre as tools
       → chama uma tool
       → recebe o resultado
```

O MCP não é a LLM e não é o agente. Ele fornece funções externas, como:

- buscar logs;
- consultar métricas;
- verificar alertas;
- consultar bancos de dados;
- acessar APIs internas;
- criar ou consultar incidentes;
- buscar informações em sistemas corporativos.

## 4. Configurar um MCP

O servidor pode ser configurado pela interface gráfica em:

```text
IA → Configurar servidores MCP
```

Cada servidor tem estes campos:

- **Nome:** identificador do servidor;
- **Transporte:** `stdio`, `sse` ou `streamable_http`;
- **Comando:** executável usado somente em `stdio`;
- **Argumentos:** argumentos do comando usado somente em `stdio`;
- **URL:** endereço usado em `sse` ou `streamable_http`;
- **Habilitado:** define se o servidor será utilizado.

## 5. Transporte `stdio`

No `stdio`, o K8sOps inicia o servidor MCP como processo filho e conversa com ele por `stdin` e `stdout`.

```text
K8sOps inicia o processo
  ↓
handshake MCP por stdin/stdout
  ↓
tools descobertas e chamadas
  ↓
processo encerrado ao terminar a sessão
```

Use esse transporte para servidores locais em Python, Node ou executáveis.

Na interface:

```text
Comando:    /Users/usuario/.local/bin/uv
Argumentos: run --directory /caminho/projeto python servidor.py
URL:        vazio
```

O comando completo executado será:

```bash
/Users/usuario/.local/bin/uv run --directory /caminho/projeto python servidor.py
```

Não coloque `kubecli ai mcp test` nos argumentos. Esse é um comando do cliente para testar o servidor.

## 6. Transporte `sse`

No `sse`, o servidor já fica executando em um endereço HTTP. O K8sOps conecta à URL SSE.

```text
Servidor MCP externo executando
        ↑↓ SSE/HTTP
K8sOps conecta e chama as tools
```

Configuração:

```text
Transporte: sse
URL:        http://127.0.0.1:3000/sse
Comando:    vazio
Argumentos: vazio
```

O K8sOps não inicia o processo nesse transporte. O servidor precisa estar ativo antes do teste.

## 7. Transporte `streamable_http`

No `streamable_http`, o servidor também é iniciado separadamente, mas utiliza o transporte HTTP streamable do MCP.

Configuração:

```text
Transporte: streamable_http
URL:        http://127.0.0.1:3000/mcp
Comando:    vazio
Argumentos: vazio
```

Exemplo FastMCP:

```python
from fastmcp import FastMCP

mcp = FastMCP("meu-servidor")

@mcp.tool()
def status() -> str:
    return "Servidor funcionando"

if __name__ == "__main__":
    mcp.run(
        transport="streamable-http",
        host="127.0.0.1",
        port=3000,
        path="/mcp",
    )
```

Inicie o servidor em outro terminal:

```bash
python servidor.py
```

O K8sOps deve usar a URL completa, incluindo `/mcp`.

## 8. Descobrir tools

Listar servidores cadastrados:

```bash
ai mcp list
```

Descobrir tools de todos os servidores habilitados:

```bash
ai mcp test
```

Descobrir tools de apenas um servidor:

```bash
ai mcp test nome-do-servidor
```

Exemplo:

```text
[OK] teste-http: teste-http_hello_http
```

O prefixo do nome da tool evita conflitos entre servidores diferentes.

## 9. Chamar uma tool diretamente

`mcp call` não usa LLM. Ele conecta ao MCP, chama a tool e mostra o resultado bruto:

```bash
ai mcp call teste-http teste-http_hello_http \
  --arguments '{"name":"Dyego"}'
```

Fluxo:

```text
K8sOps → MCP → tool → retorno bruto
```

## 10. Chamar uma tool e formatar com LLM

`mcp ask` chama somente a tool escolhida e envia o retorno para a LLM configurada:

```bash
ai mcp ask teste-http teste-http_hello_http \
  --arguments '{"name":"Dyego"}'
```

Fluxo:

```text
K8sOps → MCP → tool → LLM → resposta formatada
```

Esse comando não carrega `AGENTS.md`, não executa `kubectl` e não inicia troubleshooting.

## 11. MCP dentro do agente

Quando o usuário usa `ai ask`, as tools MCP habilitadas ficam disponíveis para o agente junto com `run_kubectl`.

```bash
ai ask "Consulte a ferramenta de métricas e compare com os pods com falha"
```

Nesse fluxo a LLM decide se deve chamar uma tool MCP. O resultado volta para o agente, que pode combiná-lo com as evidências do cluster e produzir um diagnóstico.

## 12. Comparação dos comandos

| Comando | Usa MCP | Usa LLM | Usa agente/Kubernetes |
|---|---:|---:|---:|
| `ai mcp list` | não conecta | não | não |
| `ai mcp test` | handshake e descoberta | não | não |
| `ai mcp call` | chama tool | não | não |
| `ai mcp ask` | chama tool | sim, somente para formatar | não |
| `ai ask` | pode chamar tools | sim | sim |

## 13. Problemas comuns

### Tool não aparece

Verifique se o servidor está habilitado e execute:

```bash
ai mcp test nome-do-servidor
```

### Erro `uv não tem argumentos`

Em `stdio`, o campo Comando deve conter `uv` e o campo Argumentos deve conter o restante:

```text
Comando:    uv
Argumentos: run --directory /caminho python servidor.py
```

### Erro `Session terminated` em HTTP

Verifique se o servidor está executando e se a URL contém a rota correta:

```text
http://127.0.0.1:3000/mcp
```

### O servidor inicia duas vezes

Em `stdio`, cada nova conexão inicia um processo. Para manter um servidor persistente, use `sse` ou `streamable_http`.
