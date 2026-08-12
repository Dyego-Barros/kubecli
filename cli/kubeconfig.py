from __future__ import annotations
import getpass
import json
from runtime import prompt_required, run_kubectl

def add() -> int:
    cluster_name = prompt_required("Nome do cluster")
    server = prompt_required("URL do servidor Kubernetes (ex.: https://...:6443)")
    token = getpass.getpass("Token de acesso (não será exibido): ").strip()
    if not token:
        print("Token é obrigatório nesta configuração genérica.")
        return 1
    user_name = f"admin-{cluster_name}"
    commands = [
        ["config", "set-cluster", cluster_name, f"--server={server}"],
        ["config", "set-credentials", user_name, f"--token={token}"],
        ["config", "set-context", cluster_name, f"--cluster={cluster_name}", f"--user={user_name}", "--namespace=default"],
        ["config", "use-context", cluster_name],
    ]
    for args in commands:
        result = run_kubectl(args)
        if result.returncode:
            return result.returncode
    print(f"Cluster '{cluster_name}' adicionado e contexto selecionado.")
    return 0

def remove(cluster_name: str | None = None) -> int:
    cluster_name = cluster_name or prompt_required("Nome do cluster para remover")
    result = run_kubectl(["config", "view", "-o", "json"], capture=True)
    if result.returncode:
        return result.returncode
    try:
        config = json.loads(result.stdout)
    except json.JSONDecodeError:
        print("Não foi possível interpretar o kubeconfig.")
        return 1
    contexts = [item for item in config.get("contexts", []) if item.get("context", {}).get("cluster") == cluster_name]
    if not any(item.get("name") == cluster_name for item in config.get("clusters", [])) and not contexts:
        print(f"Cluster '{cluster_name}' não encontrado.")
        return 1
    users = {item.get("context", {}).get("user") for item in contexts if item.get("context", {}).get("user")}
    for context in contexts:
        result = run_kubectl(["config", "delete-context", context["name"]])
        if result.returncode:
            return result.returncode
    result = run_kubectl(["config", "delete-cluster", cluster_name])
    if result.returncode:
        return result.returncode
    if input("Remover também os usuários associados? [s/N]: ").strip().lower() in {"s", "sim", "y", "yes"}:
        for user in users:
            result = run_kubectl(["config", "unset", f"users.{user}"])
            if result.returncode:
                return result.returncode
    print(f"Cluster '{cluster_name}' removido do kubeconfig.")
    return 0
