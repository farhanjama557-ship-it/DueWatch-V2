# Ask DW Conversation / Case State v0

M1D adds a deterministic conversation-state machine for Ask DW.

It does not interpret natural language by itself. A resolver/orchestrator may propose a typed event; this module decides whether that event is a valid state transition.

## Durable state

The case state stores references and workflow continuity:

- tenant + conversation identity
- active case and at most three recent cases
- active client/invoice/dispute references
- resolved invoice candidates
- investigation state
- artifact/evidence references
- bounded open-question metadata
- recommendation reference
- reference bindings such as `him -> client:<id>`
- bounded offered-action history
- presentation tone/detail

It intentionally does not store invoice balances, payment values, due dates, canonical financial rows, raw tool outputs, permission snapshots, or an `authorized=true` decision.

## Critical action rule

`CONFIRM_ACTION_REFERENCE` means only:

> The founder's current utterance was resolved to this exact previously-offered action.

It produces:

`CONFIRMED_PENDING_REVALIDATION`

It never produces execution authority.

Before M1E may execute anything, it must:

1. re-fetch fresh live state,
2. resolve the exact action target,
3. call the existing deterministic DueWatch authority boundary,
4. execute only if that separate authority boundary permits it,
5. return a receipt.

## Correction rule

Changing/correcting an active invoice clears invoice-derived artifact/evidence/recommendation context and invalidates an active action that targeted the old invoice.

Changing the active client clears client/invoice-derived context and invalidates an active action that targeted the old client.

This prevents:

`"nah the other invoice"` -> `"do it"`

from accidentally executing an action prepared for the first invoice.

## Concurrency and tenancy

Every event must include:

- exact `tenantId`
- `expectedVersion`
- `turnId`
- timestamp

A tenant mismatch or stale version fails closed.

## M1E

M1E will connect this state machine to Ask DW orchestration. M1D itself has no Supabase, network, provider, or financial-write dependency.
