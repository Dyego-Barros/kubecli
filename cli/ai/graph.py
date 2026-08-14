from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from typing import Annotated, Literal, TypedDict

from langgraph.graph.message import add_messages

from .config import ModelConfig, load_config
from .mcp import load_tools
from .models import ModelError, build_provider_models
from .session import Session


READ_ONLY_COMMANDS = {"get", "describe", "logs", "events", "top", "cluster-info", "auth"}
MODIFYING_COMMANDS = {
    "apply", "create", "delete", "edit", "exec", "patch", "replace", "scale",
    "rollout", "set", "label", "annotate", "taint", "cordon", "drain", "uncordon",
    "autoscale",
}
CLUSTER_SCOPED_RESOURCES = {"nodes", "node", "namespaces", "namespace", "ns", "clusterroles", "clusterrole", "clusterrolebindings", "crd", "crds", "persistentvolumes", "pv", "storageclasses", "storageclass", "sc"}


class AgentState(TypedDict):
    messages: Annotated[list, "conversation messages"]


class GraphState(TypedDict):
    messages: Annotated[list, add_messages]
    tool_rounds: int
    phase: Literal["collect", "diagnose", "act", "propose"]


def _system_prompt(session: Session) -> str:
    return f"""{session.agent_content}

Contexto Kubernetes atual: {session.context or 'não informado'}
Namespace atual: {session.namespace}

Use a ferramenta run_kubectl para coletar evidências reais. Nunca invente a saída
de comandos. Execute comandos de leitura automaticamente. Quando o usuário pedir
para resolver, corrigir, reiniciar ou fazer rollout, e a evidência indicar que a
ação é necessária, chame run_kubectl com o comando modificador em vez de apenas
imprimi-lo. O executor exibirá o comando e pedirá autorização no terminal antes
de executar; a IA não pode aprovar essa autorização por conta própria.
Se o terminal negar uma autorização, não repita o mesmo comando; registre a
recusa e continue apenas com diagnóstico ou comandos de leitura.
Execute o troubleshooting em etapas: primeiro liste os pods do namespace, depois
faça describe nos pods com problemas, consulte eventos e, quando houver RESTARTS,
consulte também os logs da execução anterior usando `kubectl logs NOME --previous`;
não use `kubectl logs pod NOME`. Só apresente o diagnóstico depois de coletar as
evidências disponíveis.
"""


def _text_content(message) -> str:
    content = getattr(message, "content", message)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for part in content:
            if isinstance(part, str):
                parts.append(part)
            elif isinstance(part, dict):
                parts.append(str(part.get("text", "")))
        return "".join(parts)
    return str(content or "")


def _evidence_from_messages(messages) -> str:
    evidence = []
    for item in messages:
        if getattr(item, "type", "") != "tool":
            continue
        evidence.append(_text_content(item)[:12000])
    return "\n\n".join(evidence)


def _confirm_modifying_command(command: list[str]) -> bool:
    """Exige autorização humana no terminal antes de executar uma alteração."""
    if not sys.stdin.isatty():
        return False
    print("\nA IA solicitou a execução de um comando modificador:")
    print(f"  {' '.join(command)}")
    print("Essa ação pode alterar recursos do cluster.")
    try:
        answer = input("Autorizar execução? [s/N]: ").strip().lower()
    except (EOFError, KeyboardInterrupt):
        print("Autorização cancelada.")
        return False
    return answer in {"s", "sim", "y", "yes"}


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

    denied_commands: set[str] = set()

    @tool(args_schema=KubectlInput)
    def run_kubectl(args: list[str] | None = None) -> str:
        """Executa kubectl; alterações exigem confirmação explícita no terminal."""
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
        command = values[0]
        if command not in READ_ONLY_COMMANDS and command not in MODIFYING_COMMANDS:
            return "AÇÃO BLOQUEADA: comando kubectl não permitido sem confirmação."
        explicit_namespace = any(item in {"-n", "--namespace", "-A", "--all-namespaces"} or item.startswith("--namespace=") for item in values)
        target = next((item for item in values[1:] if not item.startswith("-") and "=" not in item), "")
        namespaced = command in {"logs", "events", "apply", "create", "delete", "edit", "exec", "patch", "replace", "scale", "set", "label", "annotate", "rollout"} or (command in {"get", "describe", "top"} and target.split("/", 1)[0] not in CLUSTER_SCOPED_RESOURCES)
        if session.context:
            values = ["--context", session.context, *values]
        if session.namespace and namespaced and not explicit_namespace:
            values.extend(["-n", session.namespace])
        elif session.namespace and namespaced and any(item in {"-A", "--all-namespaces"} for item in values):
            values = [item for item in values if item not in {"-A", "--all-namespaces"}]
            values.extend(["-n", session.namespace])
        if command in MODIFYING_COMMANDS:
            authorization_command = " ".join(["kubectl", *values])
            if authorization_command in denied_commands:
                return "AÇÃO NÃO AUTORIZADA: esse comando já foi recusado no terminal; não o repita."
            if not _confirm_modifying_command(["kubectl", *values]):
                denied_commands.add(authorization_command)
                return "AÇÃO NÃO AUTORIZADA: o comando modificador não foi confirmado no terminal."
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


async def _build_graph(session: Session, models: list[ModelConfig], servers=None):
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
    from langgraph.graph import END, START, StateGraph
    from langgraph.prebuilt import ToolNode, tools_condition

    tool = _make_kubectl_tool(session)
    mcp_tools, mcp_errors = await load_tools(servers or [])
    collector_tools = [tool, *mcp_tools]
    collector_models = build_provider_models(collector_tools, models)
    analysis_models = build_provider_models([], models)

    async def collect(state: GraphState):
        messages = [
            SystemMessage(
                content=_system_prompt(session)
                + ("\nFerramentas MCP disponíveis: " + ", ".join(item.name for item in mcp_tools) if mcp_tools else "")
                + ("\nServidores MCP indisponíveis: " + "; ".join(mcp_errors) if mcp_errors else ""),
            ),
            *state["messages"],
        ]
        tool_rounds = state.get("tool_rounds", 0)
        failures = []
        if tool_rounds >= 8:
            return {
                "messages": [
                    HumanMessage(
                        content=(
                            "A coleta atingiu o limite de segurança. Pare de chamar ferramentas "
                            "e encaminhe as evidências já coletadas para diagnóstico."
                        )
                    )
                ],
                "phase": "diagnose",
            }
        for provider, model in collector_models:
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
                return {
                    "messages": [response],
                    "tool_rounds": tool_rounds + (1 if response.tool_calls else 0),
                    "phase": "collect",
                }
            except Exception as error:
                failures.append(f"{provider}: {type(error).__name__}")
                # O fallback é deliberadamente sequencial, como no lia_backend.
                continue
        raise ModelError("Todos os modelos falharam: " + ", ".join(failures))

    async def diagnose(state: GraphState):
        evidence = _evidence_from_messages(state["messages"])
        prompt = f"""Você está na etapa DIAGNÓSTICO de um troubleshooting Kubernetes.

Sessão: contexto={session.context or 'não informado'}, namespace={session.namespace}.
Analise somente as evidências reais abaixo. Separe fatos observados de hipóteses,
aponte a causa provável dos restarts e informe o nível de confiança. Não invente
comandos, saídas ou causas que não estejam sustentadas pelas evidências.

EVIDÊNCIAS:
{evidence or 'Nenhuma evidência de ferramenta foi coletada.'}
"""
        failures = []
        for provider, model in analysis_models:
            try:
                response = await model.ainvoke(
                    [SystemMessage(content=_system_prompt(session)), *state["messages"], HumanMessage(content=prompt)]
                )
                if not _text_content(response).strip():
                    raise ModelError(f"{provider} retornou diagnóstico vazio.")
                session.models_used.append(provider)
                return {"messages": [response], "phase": "diagnose"}
            except Exception as error:
                failures.append(f"{provider}: {type(error).__name__}")
        raise ModelError("Todos os modelos falharam no diagnóstico: " + ", ".join(failures))

    async def act(state: GraphState):
        """Decide requested changes through the guarded tool, never by text."""
        prompt = """Você está na etapa AÇÃO AUTORIZÁVEL do troubleshooting.

O pedido original do usuário está na conversa. Verifique se ele pediu para
resolver/corrigir/reiniciar/fazer rollout e se o diagnóstico mostra que uma ação
modificadora é necessária. Se sim, chame run_kubectl agora com UM comando exato;
não escreva o comando como texto. O executor exibirá a confirmação no terminal.
Se não houver necessidade ou autorização implícita suficiente no pedido, responda
sem chamar ferramenta e encaminhe para a proposta. Nunca diga que uma ação foi
recusada ou executada sem uma mensagem de ferramenta comprovando isso.
"""
        messages = [SystemMessage(content=_system_prompt(session)), *state["messages"], HumanMessage(content=prompt)]
        failures = []
        if state.get("tool_rounds", 0) >= 8:
            return {"messages": [HumanMessage(content="Não execute novas ações; encaminhe para a proposta.")], "phase": "propose"}
        for provider, model in collector_models:
            try:
                response = await model.ainvoke(messages)
                for call in getattr(response, "tool_calls", []) or []:
                    call_args = call.get("args", {})
                    if isinstance(call_args, dict) and "v__args" in call_args:
                        call["args"] = {"args": call_args["v__args"]}
                session.models_used.append(provider)
                return {
                    "messages": [response],
                    "tool_rounds": state.get("tool_rounds", 0) + (1 if response.tool_calls else 0),
                    "phase": "act",
                }
            except Exception as error:
                failures.append(f"{provider}: {type(error).__name__}")
        raise ModelError("Todos os modelos falharam na autorização da ação: " + ", ".join(failures))

    async def propose(state: GraphState):
        evidence = _evidence_from_messages(state["messages"])
        prompt = f"""Você está na etapa PROPOSTA DE SOLUÇÃO de um troubleshooting Kubernetes.

Com base apenas no diagnóstico e nas evidências da conversa, responda em português
com exatamente estas seções:

### Diagnóstico
### Evidências
### Solução possível
### Confirmação necessária
### Validação pós-solução

Em Solução possível, descreva os comandos modificadores apenas como proposta.
Não afirme que um comando foi executado sem uma evidência de ferramenta com
`exit_code`. Se a coleta não executou uma ação, descreva-a como proposta. Em
Confirmação necessária, só use “recusada” se houver uma mensagem de ferramenta
com `AÇÃO NÃO AUTORIZADA`; caso contrário, informe que ainda aguarda autorização.
Em Validação pós-solução, descreva quais comandos de leitura serão usados após a
aprovação.

EVIDÊNCIAS COLETADAS:
{evidence or 'Nenhuma evidência disponível.'}
"""
        failures = []
        for provider, model in analysis_models:
            try:
                response = await model.ainvoke(
                    [SystemMessage(content=_system_prompt(session)), *state["messages"], HumanMessage(content=prompt)]
                )
                if not _text_content(response).strip():
                    raise ModelError(f"{provider} retornou proposta vazia.")
                session.models_used.append(provider)
                return {"messages": [response], "phase": "propose"}
            except Exception as error:
                failures.append(f"{provider}: {type(error).__name__}")
        raise ModelError("Todos os modelos falharam na proposta: " + ", ".join(failures))

    workflow = StateGraph(GraphState)
    workflow.add_node("collect", collect)
    workflow.add_node("tools", ToolNode(collector_tools, handle_tool_errors=True))
    workflow.add_node("diagnose", diagnose)
    workflow.add_node("act", act)
    workflow.add_node("propose", propose)
    workflow.add_edge(START, "collect")
    workflow.add_conditional_edges(
        "collect",
        lambda state: "tools" if state.get("phase") == "collect" and tools_condition(state) == "tools" else "diagnose",
        {"tools": "tools", "diagnose": "diagnose"},
    )
    workflow.add_conditional_edges(
        "tools",
        lambda state: "act" if state.get("phase") == "act" else "collect",
        {"act": "act", "collect": "collect"},
    )
    workflow.add_edge("diagnose", "act")
    workflow.add_conditional_edges(
        "act",
        lambda state: "tools" if tools_condition(state) == "tools" else "propose",
        {"tools": "tools", "propose": "propose"},
    )
    workflow.add_edge("propose", END)
    return workflow.compile()


async def _run_graph(session: Session, request: str, models: list[ModelConfig], servers=None) -> str:
    from langchain_core.messages import HumanMessage

    try:
        graph = await asyncio.wait_for(_build_graph(session, models, servers), timeout=30)
        result = await asyncio.wait_for(
            graph.ainvoke(
                {"messages": [HumanMessage(content=request)], "tool_rounds": 0, "phase": "collect"},
                config={"configurable": {"thread_id": session.agent_path}, "recursion_limit": 40},
            ),
            timeout=180,
        )
    except asyncio.TimeoutError as error:
        raise ModelError("O troubleshooting excedeu o tempo limite (30s na preparação ou 180s na execução).") from error
    except Exception as error:
        if type(error).__name__ == "GraphRecursionError":
            raise ModelError("O agente entrou em um ciclo de ferramentas e foi interrompido com segurança.") from error
        raise
    response = _text_content(result["messages"][-1]).strip()
    session.last_request = request
    session.last_response = str(response).strip()
    session.save()
    return f"[{session.models_used[-1]}]\n{session.last_response}"


def run_graph(session: Session, request: str, models: list[ModelConfig], session_file=None, servers=None) -> str:
    if not models:
        models, _ = load_config()
    result = asyncio.run(_run_graph(session, request, models, servers))
    if session_file:
        session.save(session_file)
    return result
