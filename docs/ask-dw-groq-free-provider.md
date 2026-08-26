# Ask DW — Groq Free Provider Migration

This patch removes the paid OpenAI provider path from the deployed Ask DW model function and targets Groq's OpenAI-compatible Responses API.

## Provider

- Endpoint: `https://api.groq.com/openai/v1/responses`
- Primary default: `openai/gpt-oss-120b`
- Verifier default: `openai/gpt-oss-120b`
- Allowed alternates: `openai/gpt-oss-20b`
- Strict JSON schema: required
- Reasoning: medium for primary, high for VERIFY
- `store: false`
- Existing JWT gate, user allowlist, and `ASK_DW_MODEL_ENABLED` kill switch remain intact.

## Free-tier safeguards

The provider deliberately caps serialized request envelopes at 12,000 characters and model outputs at 1,200–1,600 tokens. This is stricter than the old paid-provider profile because Groq's free GPT-OSS tier currently has an 8K token-per-minute limit.

HTTP 429 is returned to the caller as a typed `GROQ_RATE_LIMITED` condition with `Retry-After` propagated when Groq sends it.

## Secrets

The function reads:

- `GROQ_API_KEY`
- `GROQ_PRIMARY_MODEL`
- `GROQ_VERIFIER_MODEL`

It does **not** read:

- `OPENAI_API_KEY`
- `OPENAI_PRIMARY_MODEL`
- `OPENAI_VERIFIER_MODEL`

Keep `ASK_DW_MODEL_ENABLED=false` until the Groq key is stored, the function is deployed from the committed patch, and a single allowlisted test is ready.

## Important capacity note

Free does not mean unlimited. The free tier is appropriate for development and a bounded beta. DueWatch should continue routing deterministic questions to canonical code rather than spending model quota on simple arithmetic or record lookup.
