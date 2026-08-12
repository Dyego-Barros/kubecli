COMMANDS = {"kubectl": "kubectl", "kubens": "kubens", "kubectx": "kubectx", "oc": "oc"}
COMMAND_ALIASES = {
    "k": ("kubectl", []), "kc": ("kubectl", []), "po": ("kubectl", ["get", "pods"]),
    "pods": ("kubectl", ["get", "pods"]), "svc": ("kubectl", ["get", "services"]),
    "deploy": ("kubectl", ["get", "deployments"]), "nodes": ("kubectl", ["get", "nodes"]),
    "events": ("kubectl", ["get", "events", "--sort-by=.lastTimestamp"]),
    "logs": ("kubectl", ["logs"]), "describe": ("kubectl", ["describe"]),
    "exec": ("kubectl", ["exec"]), "x": ("kubectx", []), "n": ("kubens", []),
}
TOOL_INSTALLERS = {
    "kubectl": ("kubectl", "kubectl"), "kubens": ("kubens", "kubens"),
    "kubectx": ("kubectx", "kubectx"), "oc": ("oc", "openshift-cli"),
    "azurecli": ("az", "azure-cli"), "awscli": ("aws", "awscli"),
    "googlecli": ("gcloud", "google-cloud-sdk"),
}
VERSION_COMMANDS = {
    "kubectl": ["version", "--client=true", "--output=json"], "kubens": ["--version"],
    "kubectx": ["--version"], "oc": ["version", "--client"],
    "azurecli": ["version"], "awscli": ["--version"], "googlecli": ["version"],
}
CLOUD_PROVIDERS = {
    "azurecli": {"binary": "az", "login": ["login"], "configure": ["login"], "status": ["account", "show"]},
    "awscli": {"binary": "aws", "login": ["configure"], "configure": ["configure"], "status": ["sts", "get-caller-identity"]},
    "googlecli": {"binary": "gcloud", "login": ["auth", "login"], "configure": ["init"], "status": ["auth", "list"]},
}
PACKAGE_MANAGER_INSTRUCTIONS = {
    "Darwin": "Instale o Homebrew em https://brew.sh/ e execute novamente o comando.",
    "Linux": "Instale apt, dnf, pacman ou zypper conforme sua distribuição e execute novamente o comando.",
    "Windows": "Instale o winget (App Installer) ou Chocolatey e execute novamente o comando.",
}
