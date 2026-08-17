"""Servidor MCP mínimo para testar a integração do K8sOps.

Execute com:
    python3 mcp_example.py

O transporte padrão do FastMCP é stdio, que é o transporte usado pela CLI.
"""

from fastmcp import FastMCP


mcp = FastMCP("kubecli-example")


@mcp.tool()
def hello_agent(name: str = "agente") -> str:
    """Retorna uma mensagem para confirmar que a ferramenta MCP foi chamada."""
    return f"Olá, {name}! A ferramenta MCP de exemplo está funcionando."


if __name__ == "__main__":
    mcp.run()
