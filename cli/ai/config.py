from __future__ import annotations

import os
import shlex
from dataclasses import dataclass
from pathlib import Path
import tomllib


@dataclass(frozen=True)
class ModelConfig:
    name: str
    provider: str
    model: str
    api_key_env: str = ""
    base_url: str = ""
    order: int = 1
    credential_account: str = ""


@dataclass(frozen=True)
class McpConfig:
    name: str
    transport: str = "stdio"
    command: str = ""
    args: tuple[str, ...] = ()
    url: str = ""
    enabled: bool = True


def config_path() -> Path:
    configured = os.environ.get("KUBECLI_CONFIG")
    if configured:
        return Path(configured).expanduser()
    primary = Path.home() / ".config/kubecli/config.toml"
    shared = Path.home() / ".config/kubecli/ai-config.toml"
    return primary if primary.exists() else shared


def load_config(path: Path | None = None) -> tuple[list[ModelConfig], list[McpConfig]]:
    target = path or config_path()
    if not target.exists():
        return [], []
    with target.open("rb") as handle:
        raw = tomllib.load(handle)
    model_items = raw.get("models", raw.get("ai", {}).get("models", []))
    models = [ModelConfig(**{**item, "credential_account": item.get("credential_account", f"kubecli-ai-model-{item.get('order', index + 1)}")}) for index, item in enumerate(model_items)]
    models.sort(key=lambda item: item.order)
    mcp_servers = []
    for item in raw.get("mcp", {}).get("servers", raw.get("mcp_servers", [])):
        raw_args = item.get("args", [])
        if isinstance(raw_args, str):
            try:
                args = tuple(shlex.split(raw_args))
            except ValueError as error:
                raise ValueError(f"MCP {item.get('name', 'sem nome')}: argumentos inválidos: {error}") from error
        elif isinstance(raw_args, (list, tuple)):
            args = tuple(str(value) for value in raw_args)
        else:
            raise ValueError(f"MCP {item.get('name', 'sem nome')}: args deve ser texto ou lista.")
        mcp_servers.append(McpConfig(args=args, **{k: v for k, v in item.items() if k != "args"}))
    return models[:3], mcp_servers
