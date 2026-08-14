from __future__ import annotations

from .config import McpConfig


def list_servers(servers: list[McpConfig]) -> int:
    if not servers:
        print("Nenhum servidor MCP configurado.")
        return 0
    for server in servers:
        status = "habilitado" if server.enabled else "desabilitado"
        target = server.url or " ".join((server.command, *server.args)).strip()
        print(f"{server.name}: {server.transport} | {status} | {target}")
    return 0
