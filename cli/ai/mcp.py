from __future__ import annotations

import asyncio
import json
from typing import Any

from .config import McpConfig
from .models import ModelConfig, ModelError, build_provider_models


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


async def check_servers(servers: list[McpConfig], server_name: str | None = None) -> int:
    """Faz handshake e lista ferramentas dos servidores MCP habilitados."""
    from langchain_mcp_adapters.client import MultiServerMCPClient

    connections = {}
    failed = False
    for server in servers:
        if server.enabled and (server_name is None or server.name == server_name):
            try:
                connections[server.name] = _connection(server)
            except ValueError as error:
                failed = True
                print(f"[ERRO] {error}")
    if not connections:
        target = f" '{server_name}'" if server_name else ""
        print(f"Nenhum servidor MCP habilitado{target} para testar.")
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


async def _invoke_tool(servers: list[McpConfig], server_name: str, tool_name: str, arguments: str = ""):
    connections = {}
    for server in servers:
        if server.enabled and server.name == server_name:
            connections[server.name] = _connection(server)
            break
    if not connections:
        raise ValueError(f"MCP não encontrado ou desabilitado: {server_name}")

    try:
        payload = json.loads(arguments or "{}")
    except json.JSONDecodeError as error:
        raise ValueError(f"Argumentos JSON inválidos: {error}") from error
    if not isinstance(payload, dict):
        raise ValueError("Os argumentos da tool devem ser um objeto JSON.")

    from langchain_mcp_adapters.client import MultiServerMCPClient
    from langchain_mcp_adapters.tools import load_mcp_tools

    client = MultiServerMCPClient(connections, tool_name_prefix=True, handle_tool_errors=True)
    # Manter descoberta e execução dentro da mesma sessão evita iniciar duas
    # vezes um servidor stdio durante um único `mcp call`.
    async with client.session(server_name) as session:
        tools = await load_mcp_tools(
            session,
            server_name=server_name,
            tool_name_prefix=True,
            handle_tool_errors=True,
        )
        tool = next((item for item in tools if item.name == tool_name), None)
        if tool is None:
            available = ", ".join(item.name for item in tools) or "nenhuma"
            raise ValueError(f"Tool não encontrada: {tool_name}. Disponíveis: {available}")
        return await tool.ainvoke(payload)


def _print_tool_result(result) -> None:
    if isinstance(result, (dict, list)):
        print(json.dumps(result, ensure_ascii=False, indent=2, default=str))
    else:
        print(result)


async def call_tool(servers: list[McpConfig], server_name: str, tool_name: str, arguments: str = "{}") -> int:
    """Conecta a um servidor MCP, chama uma tool diretamente e imprime o retorno."""
    _print_tool_result(await _invoke_tool(servers, server_name, tool_name, arguments))
    return 0


async def ask_tool(servers: list[McpConfig], models: list[ModelConfig], server_name: str, tool_name: str, arguments: str = "{}") -> int:
    """Chama uma tool MCP e pede à LLM configurada apenas a formatação do retorno."""
    from langchain_core.messages import HumanMessage, SystemMessage

    raw_result = await _invoke_tool(servers, server_name, tool_name, arguments)
    if isinstance(raw_result, (dict, list)):
        tool_text = json.dumps(raw_result, ensure_ascii=False, default=str)
    else:
        tool_text = str(raw_result)
    prompt = (
        "Formate a resposta da ferramenta MCP para o usuário. "
        "Não invente dados, não execute outras ferramentas e seja direto.\n\n"
        f"Resposta da ferramenta:\n{tool_text}"
    )
    failures = []
    for provider, model in build_provider_models([], models):
        try:
            response = await model.ainvoke([
                SystemMessage(content="Você é um formatador de respostas de ferramentas MCP."),
                HumanMessage(content=prompt),
            ])
            print(getattr(response, "content", response))
            return 0
        except Exception as error:
            failures.append(f"{provider}: {type(error).__name__}")
    raise ModelError("Todos os modelos falharam ao formatar a resposta: " + ", ".join(failures))
