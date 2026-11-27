#!/usr/bin/env python3
"""Publish server.json to the official MCP registry, without their CLI.

    python3 scripts/publish-to-registry.py            # show what would be sent
    python3 scripts/publish-to-registry.py --apply    # publish

Why not `mcp-publisher`: by this project's rules a third-party binary that runs
locally next to a private key has to pass the supply chain gate
(`docs/security/skill-supply-chain-gate.md` in the main repository). The gate
costs more than the exchange itself: the exchange is two requests, and both are
here in full.

The protocol is taken from the registry's sources (`cmd/publisher/auth/common.go`,
`cmd/publisher/commands/publish.go`), not from its documentation, which only
describes their CLI.

  1. timestamp = the current UTC time in RFC 3339
  2. signature = Ed25519 over the BYTES of that string, in hex
  3. POST /v0/auth/dns {domain, timestamp, signed_timestamp} -> {registry_token}
  4. POST /v0/publish with server.json and the header Authorization: Bearer <token>

The domain is proven by a TXT record on orla.finance (`v=MCPv1; k=ed25519; p=<key>`),
in place since 28.08.2026. The private half lives in
~/.claude/.secrets/orla-mcp-registry.env and is never copied here.
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

#: How the domain is proven. The registry knows two ways, and both check the
#: signature with a public key it fetches from the domain itself: `/v0/auth/dns`
#: reads a TXT record, `/v0/auth/http` reads
#: `https://<domain>/.well-known/mcp-registry-auth`.
#:
#: We use the file. The TXT record on orla.finance has been there since
#: 28.08.2026 and verifies a key whose private half lived in `~/.claude/.secrets`
#: and did not survive a change of machine; there is nothing to rewrite the
#: record with, because the domain's DNS is at GoDaddy, whose API answers 401.
#: The file is put in place by the site's deploy and changes in the same PR as
#: the rest of the site, which also makes it the more honest of the two: the key
#: is visible in the repository's history.
#:
#: The old TXT record stays dead until there is access to the DNS. While it is
#: there, `/v0/auth/dns` answers 401 with the words "published record may be
#: stale", which is exactly what happened on 19.09.2026 at the first attempt.
AUTH_PATH = "/v0/auth/http"
SECRETS = pathlib.Path.home() / ".claude" / ".secrets" / "orla-mcp-registry.env"
SERVER_JSON = pathlib.Path(__file__).resolve().parents[1] / "server.json"


def seed() -> bytes:
    if not SECRETS.exists():
        sys.exit(f"{SECRETS} is missing: the domain key is created once and lives only there")
    for line in SECRETS.read_text().splitlines():
        if line.startswith("MCP_REGISTRY_ED25519_SEED"):
            return bytes.fromhex(line.split("=", 1)[1].strip())
    sys.exit(f"{SECRETS} has no MCP_REGISTRY_ED25519_SEED")


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
        sys.exit(f"the registry answered {err.code} to {path}: {err.read().decode(errors='replace')[:500]}")



def npm_carries_name(package: dict, server_name: str) -> bool:
    """The registry accepts a package into a listing only if the PUBLISHED
    package.json carries mcpName with the server's name: that is how it makes
    sure the package and the listing have one owner. We ask npm ourselves, so
    that a publish is not refused and so that the package block goes out on its
    own as soon as a release with that field is published."""
    if package.get("registryType") != "npm":
        return True  # npm is the only registry we can check; the rest goes out as is
    url = f"https://registry.npmjs.org/{package['identifier']}/{package['version']}"
    try:
        with urllib.request.urlopen(url, timeout=15) as response:
            published = json.loads(response.read())
    except urllib.error.HTTPError as err:
        print(f"  npm does not know {package['identifier']}@{package['version']} ({err.code})")
        return False
    if published.get("mcpName") == server_name:
        return True
    print(
        f"  {package['identifier']}@{package['version']} is published without "
        f'mcpName="{server_name}": the registry will not accept this package'
    )
    return False


def main() -> None:
    apply = "--apply" in sys.argv
    document = json.loads(SERVER_JSON.read_text())
    print(f"name: {document['name']}  version: {document['version']}")
    print(f"remote: {document['remotes'][0]['url']}")
    for pkg in list(document.get("packages", [])):
        if npm_carries_name(pkg, document["name"]):
            print(f"package: {pkg['identifier']}@{pkg['version']} ({pkg['registryType']})")
        else:
            document["packages"].remove(pkg)
    if not document.get("packages"):
        document.pop("packages", None)
        print("package: none declared, the listing goes out with the remote door only")

    if not apply:
        print("\nthis was a dry run. Repeat with --apply.")
        return

    # The timestamp string itself is what gets signed: the registry checks it
    # with the public key it takes from the domain. The signature's window is
    # narrow, so the time is taken right before the request.
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

    key = Ed25519PrivateKey.from_private_bytes(seed())
    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    signature = key.sign(timestamp.encode()).hex()

    token = call(
        "POST",
        AUTH_PATH,
        {"domain": DOMAIN, "timestamp": timestamp, "signed_timestamp": signature},
    ).get("registry_token")
    if not token:
        sys.exit("the exchange went through, but the answer carries no token")
    print("\ndomain confirmed, token received")

    call("POST", "/v0/publish", document, token=token)
    print(f"published: {document['name']} {document['version']}")


if __name__ == "__main__":
    main()
