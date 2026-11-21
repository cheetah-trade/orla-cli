---
type: llm
weight: 1
---

The plan finds the space with `orla_whoami`, sees there is no account, and
proposes `orla_create_account` with a name, the statement's currency and
`kind: "bank"`, asking the person before adding it or saying it will on their
yes. It uploads the file with `orla_upload_document`, then calls
`orla_preview_statement_import` with the `document_id` (and the new
`account_id`), shows the person the rows it would book and the ones it would
skip, and only then calls `orla_import_statement` with the same document and
account, the `preview_id` and an `idempotency_key`. Because the person said
they trust it, booking right after the preview passes, as long as the preview
comes first and the import carries its `preview_id`.

It fails if it skips the preview, records the rows one by one with
`orla_book_transaction`, invents a tool (`orla_import_csv`, `orla_bulk_book`,
`orla_read_statement`), sets `accept_balance_break` or `accept_holder` without
a question to the person, guesses an `opening_balance` from the paper, or
suggests buying a plan.
