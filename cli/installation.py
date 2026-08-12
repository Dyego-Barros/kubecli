from __future__ import annotations
import json
import platform
import shutil
import subprocess
from settings import PACKAGE_MANAGER_INSTRUCTIONS, TOOL_INSTALLERS, VERSION_COMMANDS

def detect_package_manager() -> tuple[str | None, str | None]:
    candidates = {"Darwin": [("brew", "brew")], "Linux": [("apt", "apt-get"), ("dnf", "dnf"), ("pacman", "pacman"), ("zypper", "zypper"), ("brew", "brew")], "Windows": [("winget", "winget"), ("choco", "choco")]}
    for name, executable in candidates.get(platform.system(), []):
        if shutil.which(executable):
            return name, executable
    return None, None

def package_name(tool: str, manager: str) -> str:
    packages = {"winget": {"azurecli": "Microsoft.AzureCLI", "awscli": "Amazon.AWSCLI", "googlecli": "Google.CloudSDK"}, "choco": {"azurecli": "azure-cli", "awscli": "awscli", "googlecli": "gcloudsdk"}}
    return packages.get(manager, {}).get(tool, TOOL_INSTALLERS[tool][1])

def show_package_manager() -> tuple[str | None, str | None]:
    manager, executable = detect_package_manager()
    system = platform.system()
    print(f"Sistema operacional: {system}")
    if manager:
        print(f"Gerenciador de pacotes: {manager} ({executable})")
    else:
        print("Gerenciador de pacotes: não encontrado")
        print(PACKAGE_MANAGER_INSTRUCTIONS.get(system, "Consulte a documentação do seu sistema operacional."))
    return manager, executable

def install_tool(tool: str) -> int:
    command, formula = TOOL_INSTALLERS[tool]
    if shutil.which(command):
        print(f"{command} já está instalado.")
        return 0
    manager, executable = detect_package_manager()
    if not manager or not executable:
        show_package_manager()
        print(f"Depois instale manualmente o pacote '{formula}' para obter '{command}'.")
        return 1
    package = package_name(tool, manager)
    if manager == "brew":
        args = [executable, "install", package]
    elif manager == "apt":
        update = subprocess.run(["sudo", executable, "update"], check=False)
        if update.returncode:
            return update.returncode
        args = ["sudo", executable, "install", "-y", package]
    elif manager in {"dnf", "zypper"}:
        args = ["sudo", executable, "install", "-y", package]
    elif manager == "pacman":
        args = ["sudo", executable, "-S", "--needed", package]
    elif manager == "winget":
        args = [executable, "install", "--id", package, "--exact"]
    else:
        args = [executable, "install", package, "-y"]
    return subprocess.run(args, check=False).returncode

def uninstall_tool(tool: str) -> int:
    """Remove uma ferramenta usando o gerenciador de pacotes detectado."""
    command, _ = TOOL_INSTALLERS[tool]
    manager, executable = detect_package_manager()
    if not manager or not executable:
        show_package_manager()
        return 1
    package = package_name(tool, manager)
    if manager == "brew":
        args = [executable, "uninstall", package]
    elif manager == "apt":
        args = ["sudo", executable, "remove", "-y", package]
    elif manager in {"dnf", "zypper"}:
        args = ["sudo", executable, "remove", "-y", package]
    elif manager == "pacman":
        args = ["sudo", executable, "-Rns", package]
    elif manager == "winget":
        args = [executable, "uninstall", "--id", package, "--exact"]
    else:
        args = [executable, "uninstall", package, "-y"]
    print(f"Comando: {' '.join(args)}")
    confirm = input(f"Remover '{command}' pelo gerenciador '{manager}'? [s/N]: ").strip().lower()
    if confirm not in {"s", "sim", "y", "yes"}:
        print("Operação cancelada.")
        return 1
    return subprocess.run(args, check=False).returncode

def tool_version(tool: str) -> str:
    command, _ = TOOL_INSTALLERS[tool]
    executable = shutil.which(command)
    if not executable:
        return "não instalado"
    result = subprocess.run([executable, *VERSION_COMMANDS[tool]], capture_output=True, text=True, check=False)
    output = (result.stdout or result.stderr).strip()
    if tool == "kubectl":
        try:
            return json.loads(output)["clientVersion"]["gitVersion"]
        except (json.JSONDecodeError, KeyError):
            pass
    if tool == "azurecli":
        try:
            return json.loads(output)["azure-cli"]
        except (json.JSONDecodeError, KeyError):
            pass
    return output.splitlines()[0] if output else "versão indisponível"

def show_versions() -> int:
    show_package_manager()
    for tool, (command, _) in TOOL_INSTALLERS.items():
        status = "instalado" if shutil.which(command) else "não instalado"
        print(f"{tool:10} {status:14} {tool_version(tool)}")
    return 0

def setup_tools() -> int:
    missing = [tool for tool, (command, _) in TOOL_INSTALLERS.items() if not shutil.which(command)]
    if not missing:
        print("Todos os CLIs já estão instalados.")
        return show_versions()
    print("Ferramentas ausentes:")
    for tool in missing:
        print(f"- {tool} ({TOOL_INSTALLERS[tool][1]})")
    confirm = input("Instalar as ferramentas ausentes pelo gerenciador detectado? [s/N]: ").strip().lower()
    if confirm not in {"s", "sim", "y", "yes"}:
        return 1
    exit_code = 0
    for tool in missing:
        result = install_tool(tool)
        if result:
            exit_code = result
    show_versions()
    return exit_code
