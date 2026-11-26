# Changelog

## 0.5.5

- The contract follows the personal door of 26.11.2026, 136 tools: debtors,
  `dry_run` on every write, a month close request, a supplier bill paid outside
  Orla, routines, the space's forwarding address, `content_text` (a CSV as text)
  on `orla_upload_document` and `direction` on `orla_missing_receipts`; the
  second names of reports are gone.
- The listing text in `plugin.json` (ChatGPT, Codex) is the one in Claude's
  directory of 26.11.2026; a review case that said counterparty checks are not
  on this connection is replaced, since `orla_counterparty_check` reads there.

## 0.5.3

- Every request to Orla says who sent it: `User-Agent: orla-cli/<version>
  (node <version>; <platform>)`. `ORLA_DEBUG=1` prints one stderr line per
  request (method, host and path, status, time), never a header, a body or a
  query string.

- The CLI and the bridge read the door's HTTP status. A 401 refreshes the
  token once and repeats the call; a second 401 is `cli.session_expired`
  (exit 3, and the bridge signs in again) instead of "Orla refused the call"
  (exit 6). A 429 is `cli.rate_limited` (exit 6) and a 503 `cli.door_closed`
  (exit 5), both with Orla's `Retry-After` in `error.details.retry_after`.
  Nothing is repeated by itself: a refused call never ran, and repeating it
  with the same arguments reuses its idempotency key.
- Every request to Orla has a deadline: 60 s, 120 s for a file upload or a
  statement import (`ORLA_REQUEST_TIMEOUT_MS`). A request past it is
  `cli.timeout` (exit 5).
- The bridge answers `ping` itself at once, and keeps reading while a call to
  Orla is in flight; calls still go to Orla one at a time, in order. A protocol
  error Orla sends with `id: null` reaches the client under the request's id.
- A sign-in waits for the browser at most five minutes
  (`ORLA_SIGN_IN_WAIT_MS`), then closes its port. A callback with the wrong
  `state`, or naming another issuer in `iss` (RFC 9207), is refused with 400
  and the sign-in keeps waiting for the real one; until now it closed the port.
- On macOS the session goes into the keychain through `security -i` on stdin,
  as hex: it is no longer in the argument list, where `ps -ww` showed the
  whole session, refresh token included, at every refresh. The write is read
  back, and a keychain that did not take it falls back to the 0600 file.
- On Windows the sign-in opens the browser through `rundll32
  url.dll,FileProtocolHandler` with the URL as one argument. Through `start`
  in a shell, cmd.exe cut the authorize URL at the first `&` and Orla refused
  it. CI runs the suite on windows-latest too.
- A list that left rows out says so. `orla accounts`, `orla tx list` and
  `orla export` print "showing N of M" on stderr and add `truncated`
  (`shown`, `total`, `reason`) beside `data` with `--json`; the export also
  names account and category lists Orla capped, whose rows show as ids or
  blanks. Until now the CSV came out short with nothing saying so.
- `orla tx add` without `--date` books today on this machine's calendar, not
  UTC's: after midnight east of Greenwich it booked yesterday.

- `orla feedback <bug|idea|problem> "text"` sends a bug, a problem or an idea
  to the Orla team through the personal door's new `orla_send_feedback` tool.
  It shows the text and asks before sending; `--yes` sends without the
  question, and without a terminal it is required (exit 2 otherwise).
  `--space <id>` names the space the report is about. Nothing in the books
  changes; Orla allows five reports an hour per person across all its ways of
  reporting, and the same text sent again within ten minutes is sent once
  (`data.already_sent` with `--json`).
- `contracts/mcp-personal-tools.json` follows Orla's personal door: 24 tools
  with `orla_send_feedback`.

## 0.5.2

- `orla logout` revokes the connection on Orla before it forgets the session
  (RFC 7009, at the `revocation_endpoint` from Orla's OAuth metadata). Only
  this client's tokens end; the person's other connections keep working. When
  Orla offers no revocation endpoint, cannot be reached or refuses, the session
  is still forgotten and the CLI says it was forgotten on this machine only.
  `--json` carries `revoked` and, when false, `reason` and `detail`. The
  endpoint is used only on the session's own origin.
- `release.yml` runs the test suite before it publishes.
- `orla export` no longer loses rows when Orla cuts a page to fit its size
  ceiling. The next page starts where the last one ended
  (`answer_truncated.next_offset` when Orla names it, else after the rows
  that came back), and a cut page is not taken for the last one: the walk
  goes on to `total`.

## 0.5.1

- `orla export` works again. It asked Orla for 500 transactions in one call,
  Orla serves at most 200, and every export ended in a refusal (exit 6). It now
  reads every matching row in pages of 200; `--limit` stops it early.
- `orla tx list --limit` is checked before any request: a whole number from 1
  to 200, 50 by default. Anything else is a usage failure (exit 2) that names
  the bound, instead of the server's validation error.
- The stdio bridge (Claude Desktop and other clients without a terminal)
  recovers from a dead session. When Orla refuses the stored refresh token for
  good, the bridge forgets the session and opens the browser sign-in again,
  instead of answering every call with "`orla logout` and `orla login` again".
- A token refresh runs under a lock file. Orla ends the whole connection when a
  refresh token is presented twice, and two `orla` processes (or the parallel
  calls of one `orla export`) with the same expired token did exactly that.
  Whoever waits for the lock uses the tokens the first refresh saved.

## 0.5.0

- The personal door's twenty-three tools in the contract copy, and the skills
  for a first account and a bank statement.
