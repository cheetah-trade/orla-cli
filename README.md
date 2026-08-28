# orla

Your [Orla](https://orla.finance) books from a terminal, and a stdio bridge for
MCP clients that cannot speak HTTP.

```bash
npx orla-cli login
npx orla-cli tx list --from 2026-08-01
npx orla-cli export --from 2026-01-01 > books.csv
```

No dependencies, no build step, no native module to compile. Node 22 or newer.

The package is `orla-cli` and the command it installs is `orla`. They differ
because npm refused the bare name as too close to packages that already exist
(`ora`, `ol`, `rlp`, `url`), and renaming the command would have been the worse
half of that trade: `npm i -g orla-cli` still gives you `orla tx list`.

## What it is

A thin client over the same MCP endpoint Claude connects to. Every command is a
tool call, so the CLI cannot do anything a personal connection cannot do, and
nothing here has its own idea of authorization. `orla login` walks the ordinary
OAuth code flow with S256 PKCE: the browser lands on Orla's own consent page,
where you tick the spaces this machine may reach.

**It does not move money.** A personal connection reads and records. Payments,
transfers and card details belong to an agent connected for that purpose, with
its own limits, set in the app under Agents. The tools that move money are not
in the list this connection is given, and are refused at the endpoint if asked
for by name.

## Commands

| Command | What it does |
|---|---|
| `orla login [--api URL]` | Connect this machine. Opens a browser. |
| `orla logout` | Forget the stored session. |
| `orla whoami` | Which connection this is and which spaces it reaches. |
| `orla spaces` | The spaces in reach. |
| `orla use <space-id>` | Remember one as the default. |
| `orla accounts` | Accounts in the space. |
| `orla tx list` | Transactions. `--from --to --search --account --limit`. |
| `orla tx add` | Record one. `--account --kind --amount --date [--payee --note]`. |
| `orla export` | The same rows as CSV on stdout. |
| `orla tools` | Which tools this connection was given. |
| `orla mcp` | stdio bridge (below). |

`--space <id>` on anything space-scoped, `--json` for machine-readable output.

## As an MCP server

Orla's MCP server is remote and speaks Streamable HTTP:

```
https://app.orla.finance/api/mcp
```

A client that supports remote MCP needs nothing from this package. Point it at
that URL and it will find the consent page by itself. Claude Code, for example:

```bash
claude mcp add --transport http orla https://app.orla.finance/api/mcp
```

Clients that only support stdio servers can run this CLI as one. It relays
JSON-RPC to the HTTP endpoint and holds the token, so the client needs no OAuth
support of its own:

```json
{
  "mcpServers": {
    "orla": { "command": "npx", "args": ["-y", "orla-cli", "mcp"] }
  }
}
```

Run `npx orla-cli login` once first. The bridge uses that session and refreshes it.

Setup for individual clients is written up at
[orla.finance/en/ai-agents](https://orla.finance/en/ai-agents).

## Where the token lives

The OS keychain: `security` on macOS, `secret-tool` on Linux. Where neither
exists it falls back to a `0600` file under your config directory and says so
on stderr, because a refresh token quietly landing on disk is not something to
discover later.

`orla logout` clears both.

## Development

```bash
npm install
npm run check   # types
npm run build   # dist/
```

The server this talks to is not in this repository. `--api` points the CLI at a
different deployment, and the session records which one minted it, so a token
from one environment is never replayed against another.

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
