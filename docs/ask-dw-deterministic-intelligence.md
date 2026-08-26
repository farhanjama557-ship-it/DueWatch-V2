# Ask DW deterministic DW Intelligence activation

Ask DW is now an interface over DueWatch Intelligence, not a model-provider surface.

## Active invoice path

1. Authenticate the tenant.
2. Read the controlled canonical invoice/client state.
3. Read bounded invoice activity.
4. Run the governed deterministic DW Intelligence Phase 2B core.
5. Compose the answer deterministically from canonical reads + DW Intelligence state.
6. Verify deterministic invariants.
7. Return a read-only receipt proving zero external AI calls, zero provider calls, and zero writes.

## Explicitly absent from the active path

- Groq
- GPT-OSS
- OpenAI
- model planning
- model synthesis
- model verification
- provider fallback
- financial execution

## Still fail-closed

The controlled hosted schema still does not expose a payment ledger, complete execution history, DW memory/evidence tables, precedents, or prediction models. Ask DW states those limitations instead of inventing answers.

ACT requests remain blocked. PREDICT requests remain blocked until deterministic prediction data exists. DECIDE may explain safe next-step limits, but it cannot grant or execute authority.
