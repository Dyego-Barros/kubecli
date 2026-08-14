from __future__ import annotations

import os
from pathlib import Path

from .agents_md import find_agents, load_agent
from .config import config_path, load_config
from .credentials import get_credential
from .graph import run_graph
from .mcp import list_servers
from .models import ModelError
from .session import Session, detect_kube_scope


def run_ai_command(args) -> int:
    try:
        models, servers = load_config()
        action = args.ai_action
        session_file = args.session
        if action == "agents":
            agents = find_agents(args.root)
            for path in agents:
                print(path)
            if not agents:
                print("Nenhum AGENTS.md encontrado.")
            return 0
        if action in {"models", "list"}:
            if not models:
                print(f"Nenhum modelo configurado em {config_path()}")
            for model in models:
                endpoint = model.base_url or "padrão do provedor"
                token = "configurado" if (model.api_key_env and os.environ.get(model.api_key_env)) or get_credential(model.credential_account or model.api_key_env) else "não disponível"
                print(f"{model.order}. {model.name}")
                print(f"   provedor: {model.provider or 'não informado'}")
                print(f"   modelo: {model.model or 'não informado'}")
                print(f"   endpoint: {endpoint}")
                print(f"   token: {token} ({model.api_key_env or 'sem variável'})")
            return 0
        if action == "mcp":
            return list_servers(servers)
        if action == "start":
            path, content = load_agent(args.agent)
            detected_context, detected_namespace = detect_kube_scope()
            session = Session(
                str(path),
                content,
                args.context or detected_context,
                args.namespace if args.namespace != "default" else detected_namespace,
            )
            session.save(session_file)
            print(f"Sessão iniciada com {path}")
            if args.request:
                print(run_graph(session, args.request, models, session_file))
            return 0
        if action == "ask":
            try:
                session = Session.load(session_file)
            except FileNotFoundError:
                agent_path = args.agent or os.environ.get("KUBECLI_AI_AGENT")
                if not agent_path:
                    raise
                path, content = load_agent(agent_path)
                detected_context, detected_namespace = detect_kube_scope()
                session = Session(str(path), content, args.context or detected_context, args.namespace if args.namespace != "default" else detected_namespace)
                session.save(session_file)
            else:
                detected_context, detected_namespace = detect_kube_scope()
                if not session.context:
                    session.context = detected_context
                if session.namespace == "default" and detected_namespace != "default":
                    session.namespace = detected_namespace
            print(run_graph(session, " ".join(args.request), models, session_file))
            return 0
        if action == "history":
            session = Session.load(session_file)
            print(f"Agente: {session.agent_path}")
            print(f"Contexto: {session.context or 'não informado'} / {session.namespace}")
            print(f"Modelos usados: {', '.join(session.models_used) or 'nenhum'}")
            print(session.last_response or "Nenhuma resposta ainda.")
            return 0
        print("Use: kubecli ai agents, models, mcp, start, ask ou history.")
        return 2
    except (FileNotFoundError, ValueError, ModelError) as error:
        print(f"Erro: {error}")
        return 1
