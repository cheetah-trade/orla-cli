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

That is not a matter of trust in this client: `orla login` asks for the personal
address, where those tools do not exist, so the promise survives whatever gets
ticked on the consent page. `orla login --agent` asks for the other address, the
one where a bot with its own budget can be minted. A session remembers which
door issued its tokens and keeps using it, so an existing connection is not
re-pointed by an update.

## Commands

| Command | What it does |
|---|---|
| `orla login [--api URL] [--agent]` | Connect this machine. Opens a browser. `--agent` asks for the door where a bot can be minted. |
| `orla logout` | Forget the stored session. |
| `orla whoami` | Which connection this is and which spaces it reaches. |
| `orla spaces` | The spaces in reach. |
| `orla use <space-id>` | Remember one as the default. |
| `orla accounts` | Accounts in the space. |
| `orla tx list` | Transactions. `--from --to --search --account --limit`. |
| `orla tx add` | Record one. `--account --kind --amount --date [--payee --note]`. |
| `orla export` | The same rows as CSV on stdout. |
| `orla tools` | Which tools this connection was given. |
| `orla mcp [--api URL]` | stdio bridge (below). |
| `orla version` | Which version this is. |

`--space <id>` on anything space-scoped, `--json` for machine-readable output.

## For a program, or an agent

With `--json`, every command answers with one envelope on stdout:

```json
{ "ok": true, "data": ... }
{ "ok": false, "error": { "code": "cli.not_connected", "message": "not connected: run `orla login` first" } }
```

Read `ok`, then branch on `error.code`. Codes that begin `cli.` are the CLI's
own; any other code is Orla's, passed through unchanged, the same name the
REST API and the MCP endpoint use. The exit status says which kind of failure
it was, so a shell script can branch without parsing anything:

| Exit | Meaning |
|---|---|
| 0 | done |
| 1 | a failure none of the rows below describes |
| 2 | the command line: unknown command, missing flag |
| 3 | no session here, or one Orla no longer honours |
| 4 | a space-scoped command with no space to work in, or several |
| 5 | Orla could not be reached |
| 6 | Orla was reached and said no, or answered in a shape the CLI cannot read |
| 7 | signing in was abandoned or came back wrong |

The skill that teaches an agent all of this, including where paying stops, is
`skills/orla/SKILL.md`. It ships in the package and at
[orla.finance/skill.md](https://orla.finance/skill.md), and it is one of the
five skills the Claude Code plugin below installs. Into any other agent:

```bash
npx skills add cheetah-trade/orla-cli --skill orla   # any agent the skills CLI knows
curl -fsSL https://orla.finance/skill.md             # or just read it
```

For **Claude Desktop** there is a bundle, `orla-<version>.mcpb`, attached to
each release: double-click it to install. It runs the stdio bridge below, and
the bridge signs in by itself.

Environment variables the CLI reads:

| Variable | Effect |
|---|---|
| `ORLA_NO_BROWSER=1` | never launch a browser; the sign-in URL is printed on stderr instead |
| `ORLA_NO_KEYCHAIN=1` | keep the session in a `0600` file instead of the OS keychain (tests, CI, headless boxes) |
| `XDG_CONFIG_HOME` | where that file lives (`<dir>/orla/session.json`) |

## As an MCP server

Orla's MCP server is remote and speaks Streamable HTTP, and it answers at two
addresses:

```
https://app.orla.finance/api/mcp/personal   your own books, and nothing that pays
https://app.orla.finance/api/mcp            the same door plus the agent shape
```

A client that supports remote MCP needs nothing from this package. Point it at
an address and it will find the consent page by itself. Claude Code, for
example:

```bash
claude mcp add --transport http orla https://app.orla.finance/api/mcp/personal
```

The difference is not a label. At `/mcp/personal` every tool that moves money is
withheld from the list and refused if a model asks for one by name, so the
promise holds whatever the consent page was told. At `/mcp` the page offers both
shapes, and picking "connect an agent" mints a machine principal with a budget
of its own. Use the personal address unless you are deliberately connecting a
bot.

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

The bridge uses the session `orla login` stored, refreshes it, and posts to the
door that session was minted at. With no session it signs in by itself, since a client that spawned it has no terminal
to type into: it opens the browser on the consent page, stays a well-formed
server meanwhile (`initialize` and `ping` answered, `tools/list` empty, a tool
call refused with `cli.sign_in_in_progress`), and tells the client
`tools/list_changed` when the person is done.

The server is listed in the official MCP registry as **`finance.orla/orla`**,
which is the name a client or a directory should resolve it by. The entry
carries both doors: the remote endpoint above and this package for stdio.

Setup for individual clients is written up at
[orla.finance/en/mcp](https://orla.finance/en/mcp). That is the personal
connection, which reads your books and cannot pay. `/en/ai-agents` is a
different door, where an agent gets a budget and a card of its own.

## As a Claude Code plugin

This repository is also a plugin marketplace. Installing it brings five
skills, four for keeping the books and one for the CLI itself, and the personal
MCP connection they run on:

```
/plugin marketplace add cheetah-trade/orla-cli
/plugin install orla@orla
```

The first tool call opens the ordinary consent page in a browser, where you pick
the spaces this machine may reach. `/mcp` shows the connection and starts that
flow by hand.

| Skill | What it does |
|---|---|
| `orla-categorize` | Sorts uncategorized rows into categories, in batches you confirm first. |
| `orla-month-close` | Closes a month: spend, budgets that broke, what is unsorted, what the space is worth, what waits for a signature. Reads only. |
| `orla-settle-up` | Balances and the settle-up plan in a shared space, and records shared expenses from your own account of a trip. |
| `orla-counterparty-check` | What a business space knows about a counterparty or address before money goes out. |
| `orla` | The CLI from a terminal: the exact commands, the JSON envelope and exit codes, and where paying stops. |

The plugin points at `https://app.orla.finance/api/mcp/personal`, which is the
door that holds no tool that moves money. The skills say so, and the address is
what makes it true rather than a promise: payments, transfers and card details
are withheld there and refused if asked for by name.

Two things the skills lean on, worth knowing before you read them. A connection
approved without "show full details" receives payees and addresses masked, which
limits how much of a bank import can be categorized from four characters. And
the tool list stops at 200 rows per call, with the true count beside it, so a
busy month is read month by month rather than in one gulp.

`contracts/mcp-personal-tools.json` is the committed shape of that door, and
`test/skills.test.js` checks every tool and argument the skills name against it.

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

## Evals

`test/skills.test.js` checks that the skill agrees with the CLI. It cannot check
the thing the skill exists for: whether an agent reading it stops guessing. That
is what `evals/` is for. Each case runs twice, once with this plugin and once
without it, so the difference is what the skill itself changed.

| Case | What it checks |
|---|---|
| `space-default` | `orla use` takes the space id as a positional argument, and not as a `--space` flag |
| `payment-approved` | `approved` means a person signed it, not that the money left; only `executed` carries a reference |
| `cli-cannot-pay` | no command here moves money, and the answer says so instead of inventing one |

```bash
claude plugin eval .                              # both arms, three runs per case
claude plugin eval . --case space-default --runs 1
```

The MCP server stays down while they run: under the default `--mocks record` a
server with no mock is not started, so the cases need no live door, no OAuth and
no account.

### What the last run measured

2026-09-18, plugin 0.2.1, Claude Code 2.1.270, three runs per case in each arm,
model not pinned (the CLI's default, and the default judge). Whole suite: 294
seconds, $1.53.

| Case | With the skill | Without it | Δ |
|---|---|---|---|
| `space-default` | 1.00 | 0.33 | +0.67 |
| `cli-cannot-pay` | 1.00 | 0.67 | +0.33 |
| `payment-approved` | 1.00 | 0.83 | +0.17 |

Read it honestly. The skill earns most of its keep on the command surface:
without it the model got `orla use` wrong in three runs out of three, because
guessing a CLI's argument shape is exactly what it cannot do. On the money
questions the base model is already careful most of the time, and the skill
turns "most of the time" into every run, which is the part that matters when
the answer is whether somebody was paid.

Worth knowing about the baseline arm: without the skill the model usually did
not invent a command, it declined and asked to see `--help` first. That is the
better failure, and it is still a failure for an agent expected to act.

These numbers are one run on one day, not a benchmark. Re-run the command above
and you will get your own.

## License

MIT. See [LICENSE](LICENSE).
