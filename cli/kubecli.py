"""Ponto de entrada da CLI kubecli."""
from __future__ import annotations
import argparse
import sys
from collections.abc import Sequence

try:
    from . import aliases, cloud, installation, kubeconfig
    from . import prompt as prompt_commands
    from .runtime import run
    from .settings import CLOUD_PROVIDERS, COMMAND_ALIASES, COMMANDS, TOOL_INSTALLERS
except ImportError:
    import aliases, cloud, installation, kubeconfig
    import prompt as prompt_commands
    from runtime import run
    from settings import CLOUD_PROVIDERS, COMMAND_ALIASES, COMMANDS, TOOL_INSTALLERS

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="kubecli", description="Atalhos para Kubernetes, OpenShift e cloud.")
    main_commands = "{kubectl,kubens,kubectx,oc,ctx,ns,install,uninstall,list,setup,cloud,kubeconfig,aliases,ai}"
    subparsers = parser.add_subparsers(dest="command", metavar=main_commands)
    for command in COMMANDS:
        item = subparsers.add_parser(command, help=f"Executa {command}.")
        item.add_argument("args", nargs=argparse.REMAINDER)
    ctx = subparsers.add_parser("ctx", help="Lista ou troca o contexto Kubernetes.")
    ctx_sub = ctx.add_subparsers(dest="action")
    ctx_sub.add_parser("list", aliases=["ls"], help="Lista contextos.")
    ctx_use = ctx_sub.add_parser("use", help="Troca de contexto.")
    ctx_use.add_argument("name", help="Nome do contexto.")
    ns = subparsers.add_parser("ns", help="Lista ou troca o namespace atual.")
    ns_sub = ns.add_subparsers(dest="action")
    ns_sub.add_parser("list", aliases=["ls"], help="Lista namespaces.")
    ns_use = ns_sub.add_parser("use", help="Troca de namespace.")
    ns_use.add_argument("name", help="Nome do namespace.")

    install = subparsers.add_parser("install", help="Instala uma ferramenta.")
    install.add_argument("provider", choices=tuple(TOOL_INSTALLERS), help="Ferramenta a instalar.")
    uninstall = subparsers.add_parser("uninstall", help="Remove uma ferramenta instalada pelo kubecli.")
    uninstall.add_argument("provider", choices=tuple(TOOL_INSTALLERS), help="Ferramenta a remover.")
    subparsers.add_parser("list", help="Lista SO, gerenciador e versões.")
    aliases_parser = subparsers.add_parser(
        "aliases",
        help="Lista, cadastra e remove aliases.",
        description="Gerencia aliases curtos para os comandos Kubernetes.",
        epilog="Exemplo: kubecli aliases add meus-pods kubectl get pods -A",
    )
    aliases_sub = aliases_parser.add_subparsers(dest="action", metavar="{list,add,remove}")
    aliases_sub.add_parser("list", aliases=["ls"], help="Lista aliases disponíveis.")
    alias_add = aliases_sub.add_parser("add", help="Cadastra um alias personalizado.")
    alias_add.add_argument("name", help="Nome do alias.")
    alias_add.add_argument("base_command", choices=tuple(COMMANDS), help="Comando base.")
    alias_add.add_argument("args", nargs=argparse.REMAINDER, help="Argumentos fixos do alias.")
    alias_remove = aliases_sub.add_parser("remove", help="Remove um alias personalizado.")
    alias_remove.add_argument("name", help="Nome do alias.")
    subparsers.add_parser("setup", help="Verifica e instala ferramentas ausentes.")
    subparsers.add_parser("prompt", help="Mostra cluster/namespace atuais com cores.")
    shell_parser = subparsers.add_parser("shell-init", help="Gera integração do prompt do shell.")
    shell_parser.add_argument("shell", choices=("zsh", "bash"), help="Shell a configurar.")

    cloud_parser = subparsers.add_parser("cloud", help="Configura CLIs de nuvem.")
    cloud_sub = cloud_parser.add_subparsers(dest="action")
    for action, description in {"login": "Faz login.", "configure": "Configura o CLI oficial.", "status": "Mostra a identidade atual."}.items():
        item = cloud_sub.add_parser(action, help=description)
        item.add_argument("provider", choices=tuple(CLOUD_PROVIDERS), help="Provedor de nuvem.")

    kube_parser = subparsers.add_parser("kubeconfig", help="Gerencia clusters no kubeconfig.")
    kube_sub = kube_parser.add_subparsers(dest="action")
    kube_sub.add_parser("add", help="Adiciona um cluster interativamente.")
    remove = kube_sub.add_parser("remove", help="Remove um cluster.")
    remove.add_argument("cluster_name", nargs="?", help="Nome do cluster.")

    ai_parser = subparsers.add_parser("ai", help="Troubleshooting assistido por IA.")
    ai_parser.add_argument("--session", help="Arquivo de sessão independente, útil para cada aba do Electron.")
    ai_sub = ai_parser.add_subparsers(dest="ai_action", metavar="{agents,list,models,mcp,start,ask,history}")
    agents = ai_sub.add_parser("agents", help="Lista agentes AGENTS.md disponíveis.")
    agents.add_argument("root", nargs="?", help="Diretório onde procurar agentes.")
    ai_sub.add_parser("models", help="Lista os modelos configurados.")
    ai_sub.add_parser("list", help="Lista os modelos configurados (alias de models).")
    mcp = ai_sub.add_parser("mcp", help="Lista servidores MCP configurados.")
    mcp.add_argument("mcp_action", nargs="?", choices=("list",), default="list")
    start = ai_sub.add_parser("start", help="Inicia uma sessão com um AGENTS.md.")
    start.add_argument("--agent", required=True, help="Caminho do AGENTS.md.")
    start.add_argument("--context", default="", help="Contexto Kubernetes da sessão.")
    start.add_argument("--namespace", default="default", help="Namespace da sessão.")
    start.add_argument("--request", default="", help="Problema inicial (opcional).")
    ask = ai_sub.add_parser("ask", help="Executa uma pergunta usando a sessão atual.")
    ask.add_argument("--agent", help="AGENTS.md para criar a sessão automaticamente.")
    ask.add_argument("--context", default="", help="Contexto Kubernetes da sessão automática.")
    ask.add_argument("--namespace", default="default", help="Namespace da sessão automática.")
    ask.add_argument("request", nargs="+", help="Pergunta ou problema.")
    ai_sub.add_parser("history", help="Mostra a sessão atual.")
    return parser

def main(argv: Sequence[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    known_aliases = aliases.load_aliases()
    if argv and argv[0] in known_aliases:
        target, prefix = known_aliases[argv[0]]
        return run(target, [*prefix, *argv[1:]])
    if argv and argv[0] == "kubeconfig.add":
        return kubeconfig.add()
    if argv and argv[0] == "kubeconfig.remove":
        return kubeconfig.remove(argv[1] if len(argv) > 1 else None)

    parser = build_parser()
    args = parser.parse_args(argv)
    if args.command is None:
        parser.print_help()
        return 0
    if args.command in COMMANDS:
        return run(COMMANDS[args.command], args.args)
    if args.command == "ctx":
        return run("kubectx", [] if args.action in (None, "list", "ls") else [args.name])
    if args.command == "ns":
        return run("kubens", [] if args.action in (None, "list", "ls") else [args.name])
    if args.command == "install":
        return installation.install_tool(args.provider)
    if args.command == "uninstall":
        return installation.uninstall_tool(args.provider)
    if args.command == "list":
        return installation.show_versions()
    if args.command == "aliases":
        if args.action in (None, "list", "ls"):
            return aliases.show_aliases()
        if args.action == "add":
            return aliases.add_alias(args.name, args.base_command, args.args)
        if args.action == "remove":
            return aliases.remove_alias(args.name)
        parser.error("Use aliases list, aliases add ou aliases remove.")
    if args.command == "setup":
        return installation.setup_tools()
    if args.command == "prompt":
        return prompt_commands.show_prompt()
    if args.command == "shell-init":
        return prompt_commands.shell_init(args.shell)
    if args.command == "cloud":
        if args.action in {"login", "configure", "status"}:
            return cloud.cloud_command(args.provider, args.action)
        parser.error("Use cloud login, cloud configure ou cloud status.")
    if args.command == "kubeconfig":
        if args.action == "add":
            return kubeconfig.add()
        if args.action == "remove":
            return kubeconfig.remove(args.cluster_name)
        parser.error("Use kubeconfig add ou kubeconfig remove.")
    if args.command == "ai":
        try:
            from .ai.cli import run_ai_command
        except ImportError:
            try:
                from ai.cli import run_ai_command
            except ImportError:
                # Compatibilidade com execução direta de cli/kubecli.py e
                # instalações editáveis antigas que ainda não empacotaram ai/.
                from pathlib import Path
                sys.path.insert(0, str(Path(__file__).resolve().parent))
                from ai.cli import run_ai_command
        return run_ai_command(args)
    parser.error("Informe um comando válido.")
    return 2

if __name__ == "__main__":
    sys.exit(main())
