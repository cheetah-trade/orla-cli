# Releasing

Three things carry a version: the npm package, the git tag and the MCP registry
entry. They are expected to agree, and CI refuses a tag that disagrees with
`package.json`.

## One-time setup

1. **Claim the name.** The first publish cannot come from CI, because a trusted
   publisher can only be configured on a package that exists. From a machine
   logged into npm with 2FA on:

   ```bash
   npm publish --access public
   ```

2. **Configure trusted publishing** on npmjs.com for the package `orla-cli`:
   repository `cheetah-trade/orla-cli`, workflow `release.yml`. After this no
   npm token exists anywhere, and every published version carries a provenance
   attestation tying it to a commit and a build.

3. **Turn on private vulnerability reporting** in the repository's Security
   settings, so `SECURITY.md` points somewhere that works.

## Cutting a release

```bash
npm version patch          # or minor
git push --follow-tags
```

The tag starts `release.yml`, which typechecks, builds, verifies the tag
against the manifest and publishes. Nothing is published from a laptop after
the first time.

## The MCP registry entry

The server is listed as **`finance.orla/orla`**, and the DNS TXT record on
`orla.finance` is what proves the name is ours:

```
v=MCPv1; k=ed25519; p=<base64 public key>
```

Publish with `scripts/publish-to-registry.py --apply`. It signs a timestamp with
the private half of that key, exchanges it for a registry token and posts
`server.json`. Run it without `--apply` first: that prints what would go.

The official `mcp-publisher` binary does the same two requests. We do not use it
because a foreign binary running next to a private key has to clear the supply
chain gate in the main repository first, and that costs more than the exchange
it would perform. The protocol is short, and the script shows both requests
whole.

Keep `version` in step with `package.json`, and publish npm first: the registry
fetches the published `package.json` and refuses a package entry unless it
carries `"mcpName": "finance.orla/orla"`. The script asks npm about that itself
and simply leaves the package out of the entry while the field is missing, so a
release can be listed by its remote endpoint alone and gain the package later
without anyone remembering to.

Two things it will refuse, neither of which is in the registry's documentation:

- a `description` longer than 100 characters
- a package whose published `package.json` has no `mcpName`

The keypair belongs in `~/.claude/.secrets/orla-mcp-registry.env` — not in this
repository and not in CI.

## What is not released from here

The server. Tools, permissions and everything about what a connection may do
live in Orla's backend. When the personal connection's tool list changes there,
that repository's own gate says so and this client is checked against it before
the change ships.
