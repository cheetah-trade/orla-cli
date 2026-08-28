#!/usr/bin/env python3
"""Publish server.json to the official MCP registry, without their CLI.

    python3 scripts/publish-to-registry.py            # показать, что уйдёт
    python3 scripts/publish-to-registry.py --apply    # опубликовать

Почему не `mcp-publisher`: по правилам этого проекта чужой бинарь, который
запускается локально рядом с приватным ключом, проходит гейт цепочки поставок
(`docs/security/skill-supply-chain-gate.md` в основном репозитории). Гейт стоит
дороже, чем сам обмен: он состоит из двух запросов, и оба видно здесь целиком.

Протокол взят из исходников реестра (`cmd/publisher/auth/common.go`,
`cmd/publisher/commands/publish.go`), а не из документации: она описывает только
их CLI.

  1. timestamp = текущее время UTC в RFC 3339
  2. signature = Ed25519 по БАЙТАМ этой строки, в hex
  3. POST /v0/auth/dns {domain, timestamp, signed_timestamp} -> {registry_token}
  4. POST /v0/publish с server.json и заголовком Authorization: Bearer <token>

Домен доказывается TXT-записью на orla.finance (`v=MCPv1; k=ed25519; p=<ключ>`),
она стоит с 28.08.2026. Приватная часть лежит в
~/.claude/.secrets/orla-mcp-registry.env и сюда не копируется.
"""
from __future__ import annotations

import json
import pathlib
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

REGISTRY = "https://registry.modelcontextprotocol.io"
DOMAIN = "orla.finance"
SECRETS = pathlib.Path.home() / ".claude" / ".secrets" / "orla-mcp-registry.env"
SERVER_JSON = pathlib.Path(__file__).resolve().parents[1] / "server.json"


def seed() -> bytes:
    if not SECRETS.exists():
        sys.exit(f"нет {SECRETS}: ключ домена создаётся один раз и живёт только там")
    for line in SECRETS.read_text().splitlines():
        if line.startswith("MCP_REGISTRY_ED25519_SEED"):
            return bytes.fromhex(line.split("=", 1)[1].strip())
    sys.exit(f"в {SECRETS} нет MCP_REGISTRY_ED25519_SEED")


def call(method: str, path: str, body: object, token: str | None = None) -> dict:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(
        f"{REGISTRY}{path}", method=method, data=json.dumps(body).encode(), headers=headers
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as err:
        sys.exit(f"реестр ответил {err.code} на {path}: {err.read().decode(errors='replace')[:500]}")



def npm_carries_name(package: dict, server_name: str) -> bool:
    """Реестр принимает пакет в запись, только если ОПУБЛИКОВАННЫЙ package.json
    несёт mcpName с именем сервера: так он убеждается, что пакет и запись одного
    владельца. Спрашиваем npm сами, чтобы не ловить отказ публикации и чтобы
    блок пакета доехал сам, как только выйдет релиз с этим полем."""
    if package.get("registryType") != "npm":
        return True  # проверять умеем только npm; остальное отдаём как есть
    url = f"https://registry.npmjs.org/{package['identifier']}/{package['version']}"
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            published = json.loads(response.read())
    except urllib.error.HTTPError as err:
        print(f"  npm не знает {package['identifier']}@{package['version']} ({err.code})")
        return False
    if published.get("mcpName") == server_name:
        return True
    print(
        f"  {package['identifier']}@{package['version']} опубликован без "
        f'mcpName="{server_name}" — реестр такой пакет не примет'
    )
    return False


def main() -> None:
    apply = "--apply" in sys.argv
    document = json.loads(SERVER_JSON.read_text())
    print(f"имя: {document['name']}  версия: {document['version']}")
    print(f"remote: {document['remotes'][0]['url']}")
    for pkg in list(document.get("packages", [])):
        if npm_carries_name(pkg, document["name"]):
            print(f"пакет: {pkg['identifier']}@{pkg['version']} ({pkg['registryType']})")
        else:
            document["packages"].remove(pkg)
    if not document.get("packages"):
        document.pop("packages", None)
        print("пакет: не заявлен, запись уходит с одной удалённой дверью")

    if not apply:
        print("\nэто показ. Повторите с --apply.")
        return

    # Подписывается сама строка времени: реестр проверяет её и по TXT-записи
    # домена находит открытый ключ. Окно у подписи узкое, поэтому берём время
    # непосредственно перед запросом.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key = Ed25519PrivateKey.from_private_bytes(seed())
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    signature = key.sign(timestamp.encode()).hex()

    token = call(
        "POST",
        "/v0/auth/dns",
        {"domain": DOMAIN, "timestamp": timestamp, "signed_timestamp": signature},
    ).get("registry_token")
    if not token:
        sys.exit("обмен прошёл, но токена в ответе нет")
    print("\nдомен подтверждён, токен получен")

    call("POST", "/v0/publish", document, token=token)
    print(f"опубликовано: {document['name']} {document['version']}")


if __name__ == "__main__":
    main()
