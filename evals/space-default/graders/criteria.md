---
type: llm
weight: 1
---

The answer sets the default space with `orla use` and passes the space id as a
positional argument, exactly as `orla use 7f3a9c2e-4d11-4a83-9d0c-2b6f1e5a77c4`.

It fails if it passes the id through a flag (`--space`, `--id`, `--default`),
if it invents another command for this (`orla space use`, `orla config set`,
`orla switch`, `orla default`), or if it tells the person to edit a config file
by hand. The CLI has one way to do this and it is the positional form.
