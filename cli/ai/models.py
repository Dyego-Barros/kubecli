from __future__ import annotations

import logging
import os
from collections.abc import Sequence
from typing import Any
from urllib.parse import urlparse, urlunparse

from .config import ModelConfig
from .credentials import get_credential

logger = logging.getLogger(__name__)


class ModelError(RuntimeError):
    pass


class ModelLimitError(ModelError):
    pass


def _chat_base_url(config: ModelConfig) -> str | None:
    """Usa base_url como o lia_backend; o SDK adiciona a rota de chat."""
    if not config.base_url:
        return None
    parsed = urlparse(config.base_url.rstrip("/"))
    # Compatibilidade com cadastro antigo do endpoint nativo do Ollama.
    if parsed.path.endswith("/api/chat"):
        return urlunparse(parsed._replace(path="/v1"))
    if parsed.path.endswith("/chat/completions"):
        return urlunparse(parsed._replace(path=parsed.path[: -len("/chat/completions")] or "/v1"))
    return config.base_url.rstrip("/")


def _credential(config: ModelConfig) -> str:
    if config.api_key_env:
        value = os.environ.get(config.api_key_env)
        if value:
            return value
    return get_credential(config.credential_account or config.api_key_env)


def build_provider_models(tools: Sequence[Any], configurations: Sequence[ModelConfig]):
    """Cria modelos ChatOpenAI compatíveis com OpenAI, Groq e Ollama Cloud."""
    from langchain_openai import ChatOpenAI

    models = []
    missing = []
    for config in sorted(configurations, key=lambda item: item.order)[:3]:
        token = _credential(config)
        if not token:
            missing.append(config.name)
            continue
        kwargs = {
            "model": config.model,
            "temperature": 0,
            "api_key": token,
            "timeout": 90,
            "max_retries": 1,
        }
        base_url = _chat_base_url(config)
        if base_url:
            kwargs["base_url"] = base_url
        chat = ChatOpenAI(**kwargs)
        models.append((config.name, chat.bind_tools(list(tools)) if tools else chat))
    if not models:
        details = f" Tokens ausentes: {', '.join(missing)}." if missing else ""
        raise ModelError(f"Nenhum modelo de IA pôde ser inicializado.{details}")
    return models
