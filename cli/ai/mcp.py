from __future__ import annotations

import asyncio
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
        if not server.args and server.command in {"uv", "npx", "pnpm", "npm", "python", "python3"}:
            raise ValueError(
                f"MCP {server.name}: o comando {server.command!r} não tem argumentos. "
                "Informe o script/servidor no campo Argumentos."
            )
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
    async def load_one(name):
        try:
            return await client.get_tools(server_name=name), None
        except Exception as error:
            return [], f"{name}: {type(error).__name__}: {error}"

    results = await asyncio.gather(*(load_one(name) for name in connections))
    tools = []
    for loaded_tools, error in results:
        tools.extend(loaded_tools)
        if error:
            errors.append(error)
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
    async def check_one(name):
        try:
            tools = await client.get_tools(server_name=name)
            return name, ", ".join(tool.name for tool in tools) or "nenhuma ferramenta", None
        except Exception as error:
            return name, "", f"{type(error).__name__}: {error}"

    results = await asyncio.gather(*(check_one(name) for name in connections))
    for name, names, error in results:
        if error:
            failed = True
            print(f"[ERRO] {name}: {error}")
        else:
            print(f"[OK] {name}: {names}")
    return 1 if failed else 0
