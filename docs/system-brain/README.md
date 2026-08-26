# Ask DW — System Brain Audit v0

Milestone M1A generates a code-capability manifest from the DueWatch repository.

It answers one narrow question:

> What does the checked-out DueWatch code claim exists?

It does **not** query production, does **not** read tenant rows, does **not** grant business authority, and does **not** claim that a code capability is actually available in the deployed environment.

Run:

```bash
npm run system-brain:audit
```

Output:

```text
.system-brain/code-capabilities.v0.json
```

The manifest includes routes, the closed-world Ask DW read-tool vocabulary/scopes, authority action identifiers, code-level Supabase table/RPC dependencies, DW Intelligence module inventory, and deterministic SHA-256 section hashes.

## Deliberate separation

M1A = code capability manifest.

M1B will independently fingerprint the deployed Supabase structure using schema-only introspection.

M1C will compare M1A and M1B and produce a compatibility report. A code capability is not considered live merely because it appears in M1A.
