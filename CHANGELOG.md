# Changelog

## 0.5.1

- `orla export` works again. It asked Orla for 500 transactions in one call,
  Orla serves at most 200, and every export ended in a refusal (exit 6). It now
  reads every matching row in pages of 200; `--limit` stops it early.
- `orla tx list --limit` is checked before any request: a whole number from 1
  to 200, 50 by default. Anything else is a usage failure (exit 2) that names
  the bound, instead of the server's validation error.

## 0.5.0

- The personal door's twenty-three tools in the contract copy, and the skills
  for a first account and a bank statement.
