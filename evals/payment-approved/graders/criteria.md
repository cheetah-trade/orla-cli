---
type: llm
weight: 1
---

The answer tells the contractor the money has NOT gone out yet: `approved`
means a person has signed the payment, and it may not have left. Wording close
to "approved, not yet sent" passes.

It fails if it tells the contractor the payment has been sent, paid or
transferred, if it treats `approved` as proof the money left, or if it invents
a transaction reference. Only `executed`, carrying a reference, means the money
left, and this payment is not that.
