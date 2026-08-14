from __future__ import annotations

import json
import os
import subprocess
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path


def session_path(override: str | Path | None = None) -> Path:
    return Path(override or os.environ.get("KUBECLI_AI_SESSION", Path.home() / ".config/kubecli/ai-session.json")).expanduser()


def detect_kube_scope() -> tuple[str, str]:
    """Obtém contexto e namespace atuais sem falhar a sessão se kubectl não existir."""
    env = os.environ.copy()
    try:
        context = subprocess.run(["kubectl", "config", "current-context"], capture_output=True, text=True, env=env, check=False, timeout=10).stdout.strip()
        namespace = subprocess.run(["kubectl", "config", "view", "--minify", "-o", "jsonpath={.contexts[0].context.namespace}"], capture_output=True, text=True, env=env, check=False, timeout=10).stdout.strip()
        return context, namespace or "default"
    except (OSError, subprocess.SubprocessError):
        return "", "default"


@dataclass
class Session:
    agent_path: str
    agent_content: str
    context: str = ""
    namespace: str = "default"
    models_used: list[str] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    last_request: str = ""
    last_response: str = ""
    updated_at: str = ""

    def save(self, path: str | Path | None = None) -> None:
        target = session_path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        self.updated_at = datetime.now(timezone.utc).isoformat()
        target.write_text(json.dumps(asdict(self), indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    @classmethod
    def load(cls, path: str | Path | None = None) -> "Session":
        target = session_path(path)
        if not target.exists():
            raise FileNotFoundError("Nenhuma sessão de IA ativa. Use kubecli ai start --agent caminho/AGENTS.md.")
        return cls(**json.loads(target.read_text(encoding="utf-8")))
