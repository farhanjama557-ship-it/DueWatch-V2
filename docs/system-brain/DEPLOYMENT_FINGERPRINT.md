# Ask DW — System Brain Deployment Fingerprint v0

M1B answers:

> What structure is actually deployed right now?

The deployment fingerprint is intentionally separate from the M1A code-capability manifest.

## Included

- public tables
- structural column signatures
- RLS enabled/forced state
- foreign-key relationships
- RLS policy signatures
- public database function signatures
- deployed Edge Function identity/version/JWT/hash metadata
- per-section SHA-256 hashes
- one aggregate deployment hash

## Excluded

- tenant rows
- invoice/customer/payment values
- emails or document bodies
- live company state
- business authority inference

RLS is recorded as data-access structure only. It is never treated as proof that DW may perform a business action.

## Local generated files

`.system-brain/deployment-source.current.json`

`.system-brain/deployment-fingerprint.v0.json`

Both are ignored by Git.

## Refresh contract

`deployment-introspection.sql` is schema-only and can be run through a trusted Supabase administrative channel. Edge Function metadata is collected separately through the Supabase management surface. The resulting source object is then normalized and hashed by:

```bash
npm run system-brain:deployment
```

M1C will compare this deployment fingerprint with M1A's code-capability manifest and classify code/deployment drift.
