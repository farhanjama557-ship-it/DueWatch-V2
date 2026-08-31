# M2G-G1 Security and RLS

## Tenant boundary

Every Company Brain row carries `user_id`. All thirteen tables have RLS enabled. Authenticated read policies require `(select auth.uid()) = user_id`. Anonymous and authenticated table privileges are revoked first, then only `SELECT` is granted to `authenticated`.

Composite tenant foreign keys prevent a claim, root, artifact, conflict member, decision link, or tombstone from attaching to another tenant's object even if an identifier is known.

## Mutation boundary

Browser clients do not receive raw insert, update, or delete table privileges.

Two narrow `SECURITY DEFINER` functions are exposed to authenticated callers:

- `record_company_brain_founder_decision` binds actor and tenant to `auth.uid()`, validates target type and shape, returns an idempotent replay, locks the target row, records accepted or rejected-stale attempts, appends a winning decision, then advances the exact target. A stale race returns an explicit `REJECTED_STALE` result without rolling back its audit row.
- `revoke_company_brain_source` binds actor and tenant to `auth.uid()`, revokes the exact source and versions, invalidates dependent artifacts and root-linked claims, and appends an idempotent tombstone.

Both functions use an empty `search_path`, fully qualified relation names, revoked default execution, and an explicit execute grant only to `authenticated`.

The current repository's tenancy model is one authenticated owner per `user_id`, so an authenticated tenant owner is the founder at the SQL boundary. If multi-member organizations or founder roles are introduced, these functions must be amended to check the authoritative membership/role table before execute grants are retained.

## Internal ingestion worker contract

The ingestion worker is not a browser grant. A future hosted worker may use the service role only server-side and must:

- authenticate the initiating user or trusted job;
- derive tenant context from that authenticated boundary, never request body alone;
- transact the job, version, artifact, claim, root, conflict, and snapshot writes;
- include the same `user_id` on every row;
- rely on composite tenant foreign keys for semantic links;
- reject stale source versions before activation;
- never expose the service-role credential to a client or log it.

No service-role credential or hosted worker was created in G1.

## Verification level

Deterministic tests inspect all tables, RLS statements, policies, grants, composite foreign keys, RPC hardening, revocation effects, and absence of financial-table mutations. Runtime database policy behavior still requires applying the migration to an isolated local/test Supabase instance before deployment.

References used for current Supabase behavior:

- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/database/database-advisors?lint=0011_function_search_path_mutable
- https://supabase.com/docs/guides/database/hardening-data-api
