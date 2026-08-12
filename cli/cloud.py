from settings import CLOUD_PROVIDERS
from runtime import run

def cloud_command(provider: str, action: str) -> int:
    """Executa login, configuração ou status pelo CLI oficial."""
    config = CLOUD_PROVIDERS[provider]
    return run(config["binary"], config[action])
