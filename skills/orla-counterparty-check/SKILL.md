---
name: orla-counterparty-check
description: Check what an Orla business space knows about a counterparty or a wallet address before money goes out, and read open fraud findings over its crypto payouts. Use when someone asks whether an address is safe to pay, who they are about to pay, what a fraud alert means, where money already sent ended up, or wants a case report on a finding. Reads only, and says plainly when the space is not covered.
---

# Check a counterparty before paying

Five reads over a business space's counterparty monitoring: is this address
known, what is flagged, what does one finding actually say, and where did money
already sent end up.

This skill never pays anything. A personal connection holds no tool that moves
money, by design, so the answer here is input for a person's decision and never
the decision itself.

## First: is the space even covered

```
orla_risk_check(space_id, who: "<contact name or wallet address>")
```

When the space is not a business space with counterparty monitoring, the answer
is not an error. It is data that reads:

```json
{"unavailable": "Counterparty fraud monitoring exists for business spaces only."}
```

Say that, in those words, and stop. Do not fall back to a web search, a block
explorer or your own judgement about an address and present the result as though
Orla vouched for it. "I could not check this" is a useful answer. "Looks fine to
me" about a wallet you looked up elsewhere is not, and it is the sentence
somebody loses money to.

## The five reads

| Ask | Tool |
|---|---|
| Is this contact or address known, and what is on file | `orla_risk_check(space_id, who)` |
| Everything watched, with standing: attention, clear, not covered | `orla_risk_counterparties(space_id)` |
| Open findings over crypto payouts, with amount at risk | `orla_risk_alerts(space_id)` |
| One finding in full, with addresses, transactions and verdict | `orla_risk_case(space_id, which)` |
| Where money sent to a counterparty went, hop by hop | `orla_risk_trace(space_id, who, months)` |

`which` on a case is part of the finding's title, the pattern word, or a
counterparty's name. Several matches come back as a list to choose from, so show
the list rather than picking one.

`orla_risk_trace` is asynchronous at the provider: the first call starts the
trace and a call about a minute later returns the hops. Tell the person you are
waiting rather than reporting an empty first answer as "nothing found".

`orla_risk_check` and `orla_risk_trace` reach an outside screening provider.
Everything else answers from the space's own records.

## Reading the answers without overselling them

**A clear standing is not a guarantee.** "Clear" means nothing is flagged in
what this space watches. It is not a statement that an address is safe, and a
fresh wallet with no history is the case where the difference matters most.

**Addresses come back masked** unless the connection was approved with "show
full details". `•••• 73CF` is enough to recognise an address the person already
knows and not enough to verify one they do not. When you are comparing an
address a person pasted against what Orla holds, say which characters you could
actually compare.

**The verdict belongs to the person.** A personal connection cannot settle a
finding: `orla_risk_resolve` is withheld from this door, because marking a
finding "normal" silences the detector for half a year, and the text that would
prompt it was written by the counterparty being watched. Report findings, help
the person read them, and point at Orla for the verdict.

## When the answer is about a payment that has not happened

Lead with the finding, not the recommendation: what is known, what is flagged,
what is missing. Then say what you would want checked before sending. The person
sends the money in Orla or in their own wallet; nothing here does it for them,
and nothing here should read as approval.
