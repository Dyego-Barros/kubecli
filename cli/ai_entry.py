"""Entrada curta para usar a funcionalidade de IA como comando independente."""
from __future__ import annotations

import sys


def main() -> int:
    try:
        from .kubecli import main as kubecli_main
    except ImportError:
        from kubecli import main as kubecli_main
    return kubecli_main(["ai", *sys.argv[1:]])


if __name__ == "__main__":
    raise SystemExit(main())
