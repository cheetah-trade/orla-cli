# Contributing

Pull requests are welcome. This is a small package on purpose, so it helps to
know what belongs in it before you spend an evening.

## What belongs here

- Commands, flags and output formats for the terminal client.
- Fixes to the OAuth flow, token storage and the stdio bridge.
- Setup notes for an MCP client that this README does not cover yet.
- Anything that makes an error message say what to do next.

## What does not

- **New runtime dependencies.** The package has none, and that is a feature:
  `npx orla-cli` installs nothing, compiles nothing, and there is nothing here for
  a supply chain attack to reach. A PR that adds a dependency needs to argue
  for it before it needs to pass review.
- **The server.** Tools, permissions and everything about what a connection may
  do live in Orla's backend, which is not open source. The CLI cannot widen its
  own authorization, and a PR that tries to work around a refusal is fixing the
  wrong end.
- **Anything that moves money.** A personal connection reads and records. That
  boundary is enforced on the server too, so a client-side change cannot lift
  it, but it is also not what this package is for.

## Sign your commits

This project uses the [Developer Certificate of Origin](https://developercertificate.org/).
It is one line saying you wrote the patch or otherwise have the right to submit
it under the MIT license. Add it with:

```bash
git commit -s
```

which appends `Signed-off-by: Your Name <your@email>` to the message. There is
no contributor agreement to sign and nothing to fax.

## Before you open the PR

```bash
npm install
npm run check   # types, and this must be clean
npm test        # builds, then runs node:test against dist/
```

The tests use `node:test`, so there is no framework to install and nothing new
for an audit to look at. They cover the argument grammar, the CSV your books
come out as, and the stdio bridge spoken to as a client speaks to it. None of
them touch the network.

Then run the thing you changed against a real connection. `orla login --api`
points at whichever deployment you are testing against.

## Not a bug in the CLI?

Questions about an Orla account, a plan or something the app did are handled at
[support@orla.finance](mailto:support@orla.finance), not here. Issues in this
repository are read by whoever maintains the client, which is a smaller group
than the one that can look at your books.

Suspected vulnerabilities: see [SECURITY.md](SECURITY.md). Please do not open a
public issue for those.
