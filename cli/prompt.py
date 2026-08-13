from __future__ import annotations

import re
import shutil
import subprocess

try:
    from .aliases import _custom_aliases
except ImportError:
    from aliases import _custom_aliases


def current_location() -> tuple[str, str] | None:
    """Obtém contexto e namespace atuais sem instalar nada automaticamente."""
    kubectl = shutil.which("kubectl")
    if not kubectl:
        return None
    context = subprocess.run(
        [kubectl, "config", "current-context"], capture_output=True, text=True, check=False
    )
    if context.returncode != 0 or not context.stdout.strip():
        return None
    namespace = subprocess.run(
        [kubectl, "config", "view", "--minify", "-o", "jsonpath={..namespace}"],
        capture_output=True,
        text=True,
        check=False,
    )
    return context.stdout.strip(), namespace.stdout.strip() or "default"


def show_prompt() -> int:
    location = current_location()
    if location is None:
        return 0
    cluster, namespace = location
    print(f"\033[33m({cluster}\033[37m/{namespace}\033[0m)", end="")
    return 0


def shell_init(shell: str) -> int:
    """Gera integração para atualizar o prompt antes de cada comando."""
    custom_aliases = [
        f"alias {name}='kubecli {name}'"
        for name in _custom_aliases()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]*", name)
    ]
    if shell == "zsh":
        print("""# kubecli Kubernetes prompt
if [[ -z \"${KUBECLI_PROMPT_ENABLED:-}\" ]]; then
  export KUBECLI_PROMPT_ENABLED=1
  KUBECLI_BASE_PROMPT=\"$PROMPT\"
  _kubecli_prompt() {
    local location
    location=\"$(command kubecli prompt 2>/dev/null)\"
    if [[ -n \"$location\" ]]; then
      PROMPT=\"$location $KUBECLI_BASE_PROMPT\"
    else
      PROMPT=\"$KUBECLI_BASE_PROMPT\"
    fi
  }
  autoload -Uz add-zsh-hook
  add-zsh-hook precmd _kubecli_prompt
fi""")
        if custom_aliases:
            print("\n# kubecli custom aliases\n" + "\n".join(custom_aliases))
    elif shell == "bash":
        print("""# kubecli Kubernetes prompt
if [[ -z \"${KUBECLI_PROMPT_ENABLED:-}\" ]]; then
  export KUBECLI_PROMPT_ENABLED=1
  KUBECLI_BASE_PROMPT=\"$PS1\"
  _kubecli_prompt() {
    local location
    location=\"$(command kubecli prompt 2>/dev/null)\"
    PS1=\"${location:+$location }$KUBECLI_BASE_PROMPT\"
  }
  PROMPT_COMMAND=\"_kubecli_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"
fi""")
        if custom_aliases:
            print("\n# kubecli custom aliases\n" + "\n".join(custom_aliases))
    else:
        print(f"Shell não suportado: {shell}. Use zsh ou bash.")
        return 1
    return 0
