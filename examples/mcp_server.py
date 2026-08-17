"""Servidor MCP local de exemplo para testar o KubeCLI.

Este servidor não acessa Kubernetes e não altera recursos. Ele retorna dados
simulados para validar descoberta e chamada de ferramentas via transporte stdio.
"""

from __future__ import annotations

from fastmcp import FastMCP


mcp = FastMCP("kubecli-example")


@mcp.tool
def list_demo_pods(namespace: str = "girus") -> list[dict[str, object]]:
    """Lista pods simulados de um namespace para teste de troubleshooting."""
    return [
        {
            "name": "demo-backend-abc123",
            "namespace": namespace,
            "status": "Running",
            "ready": "1/1",
            "restarts": 3,
        },
        {
            "name": "demo-frontend-def456",
            "namespace": namespace,
            "status": "Running",
            "ready": "1/1",
            "restarts": 1,
        },
    ]


@mcp.tool
def describe_demo_pod(name: str) -> dict[str, object]:
    """Retorna uma descrição simulada de um pod."""
    return {
        "name": name,
        "status": "Running",
        "last_state": "Terminated",
        "exit_code": 1,
        "reason": "Error",
        "message": "connection timeout while contacting dependency",
    }


@mcp.tool
def analyze_restart(restarts: int, error_message: str = "") -> dict[str, str]:
    """Produz uma análise determinística para testar o retorno de evidências MCP."""
    if restarts <= 0:
        return {"severity": "normal", "diagnosis": "Nenhum restart informado."}
    diagnosis = "Há indícios de falha recorrente durante a execução."
    if error_message:
        diagnosis += f" Evidência recebida: {error_message}"
    return {"severity": "warning", "diagnosis": diagnosis}


if __name__ == "__main__":
    mcp.run()
