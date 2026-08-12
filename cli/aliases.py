from __future__ import annotations

import json
from pathlib import Path
from collections.abc import Sequence

from settings import COMMAND_ALIASES, COMMANDS

ALIAS_FILE = Path.home() / ".config" / "kubecli" / "aliases.json"


def load_aliases() -> dict[str, tuple[str, list[str]]]:
    aliases = {name: (target, list(args)) for name, (target, args) in COMMAND_ALIASES.items()}
    if ALIAS_FILE.exists():
        try:
            custom = json.loads(ALIAS_FILE.read_text(encoding="utf-8"))
            for name, value in custom.items():
                aliases[name] = (value["command"], value.get("args", []))
        except (OSError, json.JSONDecodeError, KeyError, TypeError):
            print(f"Aviso: não foi possível ler {ALIAS_FILE}.")
    return aliases


def _custom_aliases() -> dict[str, dict[str, list[str] | str]]:
    if not ALIAS_FILE.exists():
        return {}
    try:
        return json.loads(ALIAS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def add_alias(name: str, command: str, args: Sequence[str]) -> int:
    if name in COMMANDS or name in {"aliases", "cloud", "kubeconfig"}:
        print(f"Nome reservado: '{name}'.")
        return 1
    if command not in COMMANDS:
        print(f"Comando inválido: use um destes: {', '.join(COMMANDS)}")
        return 1
    custom = _custom_aliases()
    custom[name] = {"command": command, "args": list(args)}
    ALIAS_FILE.parent.mkdir(parents=True, exist_ok=True)
    ALIAS_FILE.write_text(json.dumps(custom, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Alias '{name}' cadastrado: {command} {' '.join(args)}".rstrip())
    return 0


def remove_alias(name: str) -> int:
    custom = _custom_aliases()
    if name not in custom:
        if name in COMMAND_ALIASES:
            print(f"'{name}' é um alias padrão e não pode ser removido.")
        else:
            print(f"Alias personalizado '{name}' não encontrado.")
        return 1
    del custom[name]
    if custom:
        ALIAS_FILE.write_text(json.dumps(custom, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    else:
        ALIAS_FILE.unlink(missing_ok=True)
    print(f"Alias '{name}' removido.")
    return 0

def show_aliases() -> int:
    """Lista os aliases disponíveis e seus comandos equivalentes."""
    for alias, (target, prefix) in load_aliases().items():
        print(f"{alias:12} -> {' '.join([target, *prefix]).strip()}")
    return 0
