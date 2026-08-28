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

`server.json` describes both ways in: the remote endpoint at
`https://app.orla.finance/api/mcp` and the npm package for clients that only
speak stdio. Publish it with the official
[`mcp-publisher`](https://github.com/modelcontextprotocol/registry) after the
npm version is live, and keep its `version` in step with `package.json`.

The name decides the authentication, and this is the one open choice:

- **`finance.orla/orla`** (what the file says) needs a DNS TXT record on
  `orla.finance` proving the domain is ours:

  ```
  v=MCPv1; k=ed25519; p=<base64 public key>
  ```

  then `mcp-publisher login dns --domain orla.finance --private-key <hex>`.
  The keypair is generated for this purpose and belongs in the secrets
  directory, not in this repository and not in CI.

- **`io.github.cheetah-trade/orla`** needs no DNS record at all:
  `mcp-publisher login github` is a device-code prompt in a browser. It is a
  one-line change to `server.json`.

The first reads as the company's, the second as a personal account's. That is
the whole difference, and it is worth two minutes in the DNS panel.

## What is not released from here

The server. Tools, permissions and everything about what a connection may do
live in Orla's backend. When the personal connection's tool list changes there,
that repository's own gate says so and this client is checked against it before
the change ships.
