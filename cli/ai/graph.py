from __future__ import annotations

import asyncio
import os
import subprocess
from typing import Annotated, TypedDict

from langgraph.graph.message import add_messages

from .config import ModelConfig, load_config
from .models import ModelError, build_provider_models
from .session import Session


READ_ONLY_COMMANDS = {"get", "describe", "logs", "events", "top", "cluster-info", "auth"}
CLUSTER_SCOPED_RESOURCES = {"nodes", "node", "namespaces", "namespace", "ns", "clusterroles", "clusterrole", "clusterrolebindings", "crd", "crds", "persistentvolumes", "pv", "storageclasses", "storageclass", "sc"}


class AgentState(TypedDict):
    messages: Annotated[list, "conversation messages"]


class GraphState(TypedDict):
    messages: Annotated[list, add_messages]
    tool_rounds: int


def _system_prompt(session: Session) -> str:
    return f"""{session.agent_content}

Contexto Kubernetes atual: {session.context or 'não informado'}
Namespace atual: {session.namespace}

Use a ferramenta run_kubectl para coletar evidências reais. Nunca invente a saída
de comandos. Execute somente comandos de leitura automaticamente. Se uma ação
modificadora for necessária, explique e peça confirmação antes de executar.
Execute o troubleshooting em etapas: primeiro liste os pods do namespace, depois
faça describe nos pods com problemas, consulte eventos e, quando houver RESTARTS,
consulte também os logs da execução anterior usando `kubectl logs NOME --previous`;
não use `kubectl logs pod NOME`. Só apresente o diagnóstico depois de coletar as
evidências disponíveis.
"""


def _make_kubectl_tool(session: Session):
    from pydantic import AliasChoices, BaseModel, Field, model_validator
    from langchain_core.tools import tool

    class KubectlInput(BaseModel):
        args: list[str] | None = Field(default=None, validation_alias=AliasChoices("args", "v__args"))

        @model_validator(mode="before")
        @classmethod
        def normalize_legacy_args(cls, values):
            if isinstance(values, dict) and "v__args" in values and "args" not in values:
                values = {**values, "args": values["v__args"]}
            return values

    @tool(args_schema=KubectlInput)
    def run_kubectl(args: list[str] | None = None) -> str:
        """Executa kubectl para diagnóstico. Use apenas get, describe, logs, events, top, cluster-info ou auth."""
        selected_args = args
        if isinstance(selected_args, str):
            selected_args = selected_args.split()
        values = [str(item) for item in (selected_args or [])]
        # Alguns modelos repetem o tipo do recurso em `kubectl logs pod NAME`.
        # A sintaxe correta para logs não contém esse token intermediário.
        if len(values) >= 3 and values[0] == "logs" and values[1] in {"pod", "pods"}:
            values.pop(1)
        if not values:
            return "ERRO DE ARGUMENTOS: informe uma lista kubectl, por exemplo ['get', 'pods']. Corrija a chamada e tente novamente."
        if values[0] not in READ_ONLY_COMMANDS:
            return "AÇÃO BLOQUEADA: comando kubectl não permitido sem confirmação."
        explicit_namespace = any(item in {"-n", "--namespace", "-A", "--all-namespaces"} or item.startswith("--namespace=") for item in values)
        command = values[0]
        target = next((item for item in values[1:] if not item.startswith("-") and "=" not in item), "")
        namespaced = command in {"logs", "events"} or (command in {"get", "describe", "top"} and target.split("/", 1)[0] not in CLUSTER_SCOPED_RESOURCES)
        if session.context:
            values = ["--context", session.context, *values]
        if session.namespace and namespaced and not explicit_namespace:
            values.extend(["-n", session.namespace])
        elif session.namespace and namespaced and any(item in {"-A", "--all-namespaces"} for item in values):
            values = [item for item in values if item not in {"-A", "--all-namespaces"}]
            values.extend(["-n", session.namespace])
        try:
            result = subprocess.run(
                ["kubectl", *values],
                capture_output=True,
                text=True,
                env=os.environ.copy(),
                timeout=60,
                check=False,
            )
        except FileNotFoundError:
            return "kubectl não encontrado no PATH."
        except subprocess.TimeoutExpired:
            return "kubectl excedeu o tempo limite de 60 segundos."
        output = result.stdout.strip()
        if result.stderr.strip():
            output = f"{output}\n{result.stderr.strip()}".strip()
        return f"$ kubectl {' '.join(values)}\nexit_code={result.returncode}\n{output[:12000]}"

    return run_kubectl


async def _build_graph(session: Session, models: list[ModelConfig]):
    from langchain_core.messages import AIMessage, SystemMessage
    from langgraph.graph import END, START, StateGraph
    from langgraph.prebuilt import ToolNode, tools_condition

    tool = _make_kubectl_tool(session)
    provider_models = build_provider_models([tool], models)

    async def assistant(state: GraphState):
        messages = [SystemMessage(content=_system_prompt(session)), *state["messages"]]
        tool_rounds = state.get("tool_rounds", 0)
        if tool_rounds >= 8:
            tool_messages = [item for item in state["messages"] if getattr(item, "type", "") == "tool"]
            evidence = []
            for item in tool_messages:
                content = item.content if isinstance(item.content, str) else str(item.content)
                evidence.append(content[:12000])
            if evidence:
                final = "Interrompi a coleta após oito etapas para evitar um ciclo de ferramentas.\n\nEvidências coletadas:\n" + "\n\n".join(evidence)
            else:
                final = "O modelo solicitou ferramentas, mas nenhuma evidência de execução foi retornada pelo ToolNode."
            return {"messages": [AIMessage(content=final)]}
        failures = []
        for provider, model in provider_models:
            try:
                response = await model.ainvoke(messages)
                # Alguns modelos OpenAI-compatible devolvem o argumento de uma
                # lista como v__args; normalize antes do ToolNode validar o schema.
                for call in getattr(response, "tool_calls", []) or []:
                    call_args = call.get("args", {})
                    if isinstance(call_args, dict) and "v__args" in call_args:
                        call["args"] = {"args": call_args["v__args"]}
                if not getattr(response, "tool_calls", None):
                    content = response.content
                    if isinstance(content, list):
                        content = "".join(
                            part.get("text", "") for part in content if isinstance(part, dict)
                        )
                    if not str(content or "").strip():
                        raise ModelError(f"{provider} retornou uma resposta vazia.")
                session.models_used.append(provider)
                return {"messages": [response], "tool_rounds": tool_rounds + (1 if response.tool_calls else 0)}
            except Exception as error:
                failures.append(f"{provider}: {type(error).__name__}")
                # O fallback é deliberadamente sequencial, como no lia_backend.
                continue
        raise ModelError("Todos os modelos falharam: " + ", ".join(failures))

    workflow = StateGraph(GraphState)
    workflow.add_node("assistant", assistant)
    workflow.add_node("tools", ToolNode([tool], handle_tool_errors=True))
    workflow.add_edge(START, "assistant")
    workflow.add_conditional_edges("assistant", tools_condition)
    workflow.add_edge("tools", "assistant")
    return workflow.compile()


async def _run_graph(session: Session, request: str, models: list[ModelConfig]) -> str:
    from langchain_core.messages import HumanMessage

    graph = await _build_graph(session, models)
    try:
        result = await graph.ainvoke(
            {"messages": [HumanMessage(content=request)], "tool_rounds": 0},
            config={"configurable": {"thread_id": session.agent_path}, "recursion_limit": 40},
        )
    except Exception as error:
        if type(error).__name__ == "GraphRecursionError":
            raise ModelError("O agente entrou em um ciclo de ferramentas e foi interrompido com segurança.") from error
        raise
    response = result["messages"][-1].content
    if isinstance(response, list):
        response = "".join(part.get("text", "") for part in response if isinstance(part, dict))
    session.last_request = request
    session.last_response = str(response).strip()
    session.save()
    return f"[{session.models_used[-1]}]\n{session.last_response}"


def run_graph(session: Session, request: str, models: list[ModelConfig], session_file=None) -> str:
    if not models:
        models, _ = load_config()
    result = asyncio.run(_run_graph(session, request, models))
    if session_file:
        session.save(session_file)
    return result
