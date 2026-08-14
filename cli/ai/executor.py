from __future__ import annotations

import json
import os
import subprocess


READ_ONLY = {"get", "describe", "logs", "events", "top", "cluster-info", "auth"}


def execute_tool_call(call: dict) -> str:
    function = call.get("function", call)
    name = function.get("name")
    raw_args = function.get("arguments", call.get("arguments", {}))
    if isinstance(raw_args, str):
        raw_args = json.loads(raw_args)
    args = [str(item) for item in raw_args.get("args", [])]
    if not args or args[0] not in READ_ONLY:
        return "AÇÃO BLOQUEADA: somente comandos kubectl de leitura são permitidos automaticamente."
    result = subprocess.run(["kubectl", *args], capture_output=True, text=True, env=os.environ.copy(), timeout=60, check=False)
    output = (result.stdout + ("\n" + result.stderr if result.stderr else "")).strip()
    return f"kubectl {' '.join(args)}\nexit_code={result.returncode}\n{output[:12000]}"
