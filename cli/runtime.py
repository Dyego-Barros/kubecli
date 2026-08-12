from __future__ import annotations
import shutil
import subprocess
from collections.abc import Sequence
from settings import TOOL_INSTALLERS

def require_binary(command: str) -> str:
    executable = shutil.which(command)
    if executable is None:
        tool = next((name for name, (binary, _) in TOOL_INSTALLERS.items() if binary == command), None)
        if tool:
            confirm = input(f"'{command}' não está instalado. Deseja instalar agora? [S/n]: ").strip().lower()
            if confirm not in {"n", "não", "nao", "no"}:
                from installation import install_tool
                install_tool(tool)
                executable = shutil.which(command)
        if executable is None:
            raise SystemExit(f"Comando '{command}' não encontrado no PATH.")
    return executable

def run(command: str, args: Sequence[str]) -> int:
    return subprocess.run([require_binary(command), *args], check=False).returncode

def run_kubectl(args: Sequence[str], *, capture: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run([require_binary("kubectl"), *args], check=False, capture_output=capture, text=True)

def prompt_required(label: str) -> str:
    while True:
        value = input(f"{label}: ").strip()
        if value:
            return value
        print("Esse valor é obrigatório.")
