# Ask DW - System Brain Compatibility / Drift Gate v0

M1C answers:

> Does the structure expected by DueWatch code exist in the deployed system?

It compares:

- M1A: `.system-brain/code-capabilities.v0.json`
- M1B: `.system-brain/deployment-fingerprint.v0.json`

and generates:

- M1C: `.system-brain/compatibility-report.v0.json`

## Statuses

`MATCH`
: The declared code dependency exists and all conservatively extractable selected columns exist.

`MISSING_TABLE`
: Code references a table absent from the deployment.

`MISSING_RPC`
: Code references an RPC absent from the public database function fingerprint.

`COLUMN_DRIFT`
: The table exists, but code selects one or more simple top-level columns that the deployment does not expose.

## Runtime rule

M1C does not globally disable DueWatch because one optional path drifted.

Instead:

`BLOCK_OR_DEGRADE_ONLY_AFFECTED_PATHS`

A dependent feature must explicitly gate itself before relying on a missing or drifted dependency.

Structural compatibility never grants business authority. RLS remains data-access structure only. The existing DueWatch authority engine remains authoritative for business actions.

## Refresh

```bash
npm run system-brain:audit
npm run system-brain:deployment
npm run system-brain:compatibility
```
