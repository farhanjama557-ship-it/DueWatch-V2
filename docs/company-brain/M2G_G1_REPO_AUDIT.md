# M2G-G1 Repository Audit

Date: 2026-08-30
Branch: `m2g/company-brain-bootstrap-g1`
G0 checkpoint and G1 base: `e6e454b07abcb283651d34c701f2b0f6426ae2a9`

## Pre-G1 gate

The complete G0 diff was reviewed before G1 began. The CRLF-neutral M2D fixture edit changed only line-ending-sensitive comparison behavior and did not change the tested business contract. No unrelated changes were included.

The reviewed G0 tree passed:

- G0 focused suite: 27/27.
- Full repository suite: 997/997.
- Production build.
- `git diff --check`.

It was committed as `M2G G0 company brain foundation gate`, then the G1 branch was created from that exact commit.

## Existing conventions reused

- Supabase migrations live under `supabase/migrations` and use timestamped SQL files.
- Tenant ownership follows the current single-user account boundary: `user_id` references `auth.users(id)` and is compared with `auth.uid()`.
- Browser access is least-privilege. Company Brain tables expose tenant-bound reads only; privileged mutations use narrow functions or an internal ingestion worker.
- G0 typed constructors, conflict detection, snapshot building, authority evaluation, Ask DW grounding, and DW Intelligence context are extended rather than duplicated.
- Node's built-in test runner remains the deterministic test harness.

No existing tables were semantically equivalent to the Company Brain durable families, so one new schema family was necessary.

## Scope findings

- There was no safe PDF text parser already installed. G1 therefore supports Markdown, text, and CSV and defers PDF rather than adding an unjustified parser or OCR stack.
- No vector or embedding system was introduced. Retrieval uses deterministic typed filters.
- No product UI was changed.
- No production provider, account, tenant data, or hosted database was accessed or mutated.
- No R0 financial table or canonical-money writer was changed.

## Environment limitation

The repository has neither a configured local Postgres runtime nor an available Supabase CLI installation. The migration was generated with the current Supabase CLI package and verified by deterministic structural tests, but was not applied to a database in this task. Applying it to an isolated local/test Supabase instance remains a deployment-stage verification, not evidence claimed by G1.
