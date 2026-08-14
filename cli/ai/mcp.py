from __future__ import annotations

from typing import Any

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


def _connection(server: McpConfig) -> dict[str, Any]:
    transport = server.transport.strip().lower().replace("-", "_")
    if transport == "http":
        transport = "streamable_http"
    if transport == "stdio":
        if not server.command:
            raise ValueError(f"MCP {server.name}: comando não configurado.")
        return {"transport": "stdio", "command": server.command, "args": list(server.args)}
    if transport in {"sse", "streamable_http"}:
        if not server.url:
            raise ValueError(f"MCP {server.name}: URL não configurada.")
        return {"transport": transport, "url": server.url}
    raise ValueError(f"MCP {server.name}: transporte inválido: {server.transport}. Use stdio, sse ou streamable_http.")


async def load_tools(servers: list[McpConfig]):
    """Conecta servidores habilitados e carrega suas ferramentas LangChain."""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    connections = {}
    errors = []
    for server in servers:
        if server.enabled:
            try:
                connections[server.name] = _connection(server)
            except ValueError as error:
                errors.append(str(error))
    if not connections:
        return [], errors

    client = MultiServerMCPClient(connections, tool_name_prefix=True, handle_tool_errors=True)
    tools = []
    for name in connections:
        try:
            tools.extend(await client.get_tools(server_name=name))
        except Exception as error:
            errors.append(f"{name}: {type(error).__name__}: {error}")
    return tools, errors


async def check_servers(servers: list[McpConfig]) -> int:
    """Faz handshake e lista ferramentas dos servidores MCP habilitados."""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    connections = {}
    failed = False
    for server in servers:
        if server.enabled:
            try:
                connections[server.name] = _connection(server)
            except ValueError as error:
                failed = True
                print(f"[ERRO] {error}")
    if not connections:
        print("Nenhum servidor MCP habilitado para testar.")
        return 1 if failed else 0

    client = MultiServerMCPClient(connections, tool_name_prefix=True, handle_tool_errors=True)
    for name in connections:
        try:
            tools = await client.get_tools(server_name=name)
            names = ", ".join(tool.name for tool in tools) or "nenhuma ferramenta"
            print(f"[OK] {name}: {names}")
        except Exception as error:
            failed = True
            print(f"[ERRO] {name}: {type(error).__name__}: {error}")
    return 1 if failed else 0
