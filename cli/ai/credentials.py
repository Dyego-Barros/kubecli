from __future__ import annotations

import os
import platform
import subprocess


SERVICE = "kubecli-ai"


def get_credential(account: str) -> str:
    """Lê uma credencial do armazenamento seguro do sistema sem imprimir o valor."""
    if not account:
        return ""
    system = platform.system()
    if system == "Darwin":
        command = ["security", "find-generic-password", "-a", account, "-s", SERVICE, "-w"]
    elif system == "Linux":
        command = ["secret-tool", "lookup", "service", SERVICE, "account", account]
    else:
        return ""
    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
    except OSError:
        return ""
    return result.stdout.strip() if result.returncode == 0 else ""
