# Security

## Reporting

Report privately through **GitHub private vulnerability reporting** on this
repository (Security tab, "Report a vulnerability"). If that is not available
to you, write to [support@orla.finance](mailto:support@orla.finance) with
`security` in the subject and we will move it off the public channel.

Please do not open a public issue for a suspected vulnerability.

## What is in scope here

This repository is the client. In scope: the OAuth flow it performs, how it
stores and refreshes tokens, the stdio bridge, and anything it writes to disk
or to a log.

Out of scope here, but very much wanted at the address above: anything about
the hosted service, its API, or what a connection is allowed to do.

## What this client can and cannot do

A personal connection reads and records. The tools that move money are not in
the list it is given, and are refused at the endpoint if asked for by name, so
a compromised or modified client cannot pay anybody. A stolen refresh token
reads books and can write bookkeeping entries. Revoke it in the app under
Agents, or run `orla logout` on the machine that holds it.
