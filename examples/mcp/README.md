# MCP de exemplo

Este servidor FastMCP é local, usa transporte `stdio` e retorna dados simulados.
Ele não executa `kubectl` nem modifica o cluster.

## Instalação

No ambiente do projeto raiz:

```bash
cd /Users/dyegobarros/Documents/Freela-Ronaldo
uv add fastmcp
```

## Configuração no KubeCLI

Adicione ao arquivo `~/.config/kubecli/ai-config.toml`:

```toml
[[mcp.servers]]
name = "demo"
transport = "stdio"
command = "uv"
args = ["run", "--project", "/Users/dyegobarros/Documents/Freela-Ronaldo", "python", "/Users/dyegobarros/Documents/Freela-Ronaldo/examples/mcp_server.py"]
enabled = true
```

No Electron, o mesmo cadastro pode ser feito em **MCP**, usando:

- Transporte: `stdio`
- Comando: `uv`
- Argumentos: `run --project /Users/dyegobarros/Documents/Freela-Ronaldo python /Users/dyegobarros/Documents/Freela-Ronaldo/examples/mcp_server.py`

## Teste

```bash
ai mcp list
ai mcp test
ai ask "Use as ferramentas MCP disponíveis para listar os pods simulados e analisar os restarts"
```

O teste deve listar ferramentas como `demo_list_demo_pods`,
`demo_describe_demo_pod` e `demo_analyze_restart`.

Não execute o arquivo diretamente esperando um prompt: servidores MCP `stdio`
ficam aguardando o protocolo MCP. O teste correto é feito por `ai mcp test`.
