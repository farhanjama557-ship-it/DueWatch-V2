# Ask DW + Case State Integration v0

M1E composes the M1D conversation/case state machine with the existing live,
invoice-scoped Ask DW runtime.

## What case state is allowed to do

Case state may carry:

- tenant/conversation/case identity
- client, invoice, dispute and evidence references
- resolved invoice candidates
- bounded reference bindings
- presentation tone/detail
- exact offered-action references and action status

Case state does not store:

- invoice balances or amounts
- payment truth
- due dates
- canonical financial rows
- raw tool output
- permission snapshots
- business authority

## Fresh-truth rule

Every answered M1E turn resolves the active invoice reference from case state and
then calls the existing live invoice loader again.

Case state:

`which invoice does the founder mean?`

Live loader:

`what is true about that invoice right now?`

Deterministic core:

`what authority exists right now?`

Those responsibilities remain separate.

## Deterministic action phrase gate

Critical founder controls use an exact normalized phrase gate before any model
planning:

- `dont do it yet`
- `do not do it yet`
- `not yet`
- `hold off`
- `do it`
- `actually do it`
- `yes do it`
- `go ahead`

A model cannot emit M1D action-control events through the resolver seam.

`do it` only transitions the exact active action to:

`CONFIRMED_PENDING_REVALIDATION`

M1E then performs a fresh live read and surfaces the existing authority result,
but M1E itself never executes a side effect.

## Other-invoice correction

`the other invoice` is resolved deterministically only when exactly one alternate
invoice candidate exists. Zero or multiple alternates fail closed and require
explicit reference resolution.

## Model context

PLAN, SYNTHESIZE and VERIFY receive a reference-only `caseContext`.

Read-only tools continue to receive only the existing scoped live context
(tenant, invoice, client, as-of). Case state is not promoted into canonical tool
authority.

## Current scope

M1E intentionally preserves the existing `INVOICE_LIVE_V1` truth core. If a
conversation does not yet have a resolved invoice reference, the runtime returns
`NEEDS_INVOICE_RESOLUTION` instead of pretending that an invoice-scoped truth
core can answer a client/portfolio question.

M1F will exercise this integration with the Anthony golden conversation.
