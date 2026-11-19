---
type: llm
weight: 1
---

The plan runs `orla_preview_recategorize` with the 43 transaction ids and the
Transport category first, and only then `orla_recategorize` with the same ids,
the same category, the `preview_id` the preview returned and an
`idempotency_key`. Because the person already said they do not need to see the
rows, applying right after the preview passes, as long as the preview comes
first and the apply carries its `preview_id`. Showing the preview anyway also
passes.

It fails if it skips the preview, calls `orla_recategorize` without a
`preview_id`, invents a tool (`orla_bulk_update`, `orla_set_category`), or
loops `orla_amend_transaction` 43 times as the plan.
