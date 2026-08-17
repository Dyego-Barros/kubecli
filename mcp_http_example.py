"""Servidor MCP HTTP para testar conexões streamable HTTP do K8sOps."""

from fastmcp import FastMCP


mcp = FastMCP("kubecli-http-example")


@mcp.tool()
def hello_http(name: str = "agente") -> str:
    """Retorna uma mensagem para confirmar a chamada via HTTP."""
    return f"Olá, {name}! A tool MCP HTTP está funcionando."


if __name__ == "__main__":
    mcp.run(
        transport="streamable-http",
        host="127.0.0.1",
        port=3000,
        path="/mcp",
    )
