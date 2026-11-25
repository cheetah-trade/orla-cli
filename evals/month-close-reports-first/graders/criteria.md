---
type: llm
weight: 1
---

The plan starts from `orla_whoami`, then the report tools
(`orla_get_spending_by_category`, `orla_cash_flow`,
`orla_get_receivables_and_payables`) for the month's summaries, before any page of transactions. Supplier bills due come
from `orla_list_bills`, and payments waiting for a signature from
`orla_list_payments`.

It fails if it plans to page through every October transaction and add the
totals up itself as the main source, if it invents a tool, or if it says it will
pay a bill or approve a payment. This connection reads bills and pays none.
