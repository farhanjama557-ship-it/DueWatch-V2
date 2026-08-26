# Ask DW Groq Live Probe — Phase 2H

This is the first UI-triggered live provider check.

## Scope

- Development builds only (`import.meta.env.DEV`)
- Invoice scope only
- Authenticated tenant must equal the request tenant
- Normal mode only
- Uses `createAskDwControlledActivationRuntime`
- Deterministic PLAN
- One Groq SYNTHESIZE call
- One Groq VERIFY call
- Read tools: canonical invoice/client state + bounded invoice activity
- No canonical mutation
- No financial action execution
- No provider secret in browser code

## Why DEV-only first

The backend is already production-deployed and gated. This probe gives a controlled way to verify the real GPT-OSS 120B provider from the existing app without prematurely shipping a permanent Ask DW UX.

After one successful live run, inspect:

1. final answer
2. verifier verdict
3. activation receipt
4. provider receipt
5. Supabase Edge Function logs
6. Groq dashboard usage

Then decide the permanent Ask DW interaction design separately.
