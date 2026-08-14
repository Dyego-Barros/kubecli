from __future__ import annotations

from pathlib import Path


def resolve_agent(path: str) -> Path:
    target = Path(path).expanduser().resolve()
    if not target.is_file():
        raise FileNotFoundError(f"AGENTS.md não encontrado: {target}")
    if target.name.lower() != "agents.md":
        raise ValueError("O agente precisa ser um arquivo chamado AGENTS.md.")
    return target


def load_agent(path: str) -> tuple[Path, str]:
    target = resolve_agent(path)
    content = target.read_text(encoding="utf-8").strip()
    if not content:
        raise ValueError(f"O agente está vazio: {target}")
    return target, content


def find_agents(root: str | None = None) -> list[Path]:
    base = Path(root or Path.home()).expanduser()
    if not base.exists():
        return []
    return sorted(path for path in base.rglob("AGENTS.md") if path.is_file())
