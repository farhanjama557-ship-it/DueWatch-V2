# M2G-G0 repository audit

Base: `dad3d1a30d211f856f158164fada4bd5ef0332d4` (`origin/main`)
Branch: `m2g/company-brain-bootstrap-g0`
Audit date: 2026-08-30

## Starting state

The current main SHA exactly matched the kickoff. The checkout was clean before branch creation. Baseline `npm test` reported 969 pass / 1 fail: the M2D config-at-rest assertion assumes LF line endings and fails on this Windows checkout's CRLF file. Baseline `npm run build` passed when run outside the restricted filesystem sandbox; its only output concern was the existing Vite chunk-size warning.

No production Supabase or provider operation was performed. G0 remains local and fixture-driven.

## Primitive map

| Existing primitive | Decision | Reason |
|---|---|---|
| `phase2bEngine.admitEvidence` | EXTEND SEMANTICS | Already rejects tenant/scope mismatches, quarantines instruction-bearing evidence, and separates admitted/context-only evidence. It is invoice/client-scoped, so the Company Brain kernel follows its fail-closed pattern without routing company artifacts through invoice-specific shapes. |
| `phase2bEngine.resolveMemory` | EXTEND SEMANTICS | Already blocks tombstoned memory, descendants, and claims whose evidence is no longer admitted. G0 generalizes the same rule to root Sources, Artifacts, Claims, derived summaries, and Brain snapshots. |
| `phase2bEngine.selectPrecedents` | REUSE CONTRACT | Precedent remains contextual and structurally checked; it does not become policy or authority. G0 exposes relevant precedent in typed DW Intelligence context only. |
| `phase2bArControl.projectAttributedClaims` | EXTEND, DO NOT CALL DIRECTLY | It preserves attribution for AR analysis but its claim vocabulary is invoice-workflow specific. Company Brain claims need company/client/global semantic scopes and root-source lineage. |
| `askDwCaseState` durable reference-only state | REUSE BOUNDARY | Conversation state explicitly rejects live financial truth and business authority. Company Brain integration supplies a typed, current snapshot by reference and never persists canonical money into conversation state. |
| Ask DW controlled/live runtimes | REUSE SEAM | They already re-read canonical truth and prohibit conversation-granted authority. G0 adds a narrow Company Brain answer/context adapter without redesigning UI or adding execution. |
| `askDwSupabaseReadTools` | REUSE OWNERSHIP RULE, NO G0 DATA CALL | It keeps canonical money reads tenant-scoped and read-only. G0's “was invoice paid?” answer routes to this authoritative R0 path rather than treating company memory as money truth. |
| `nextActionAuthority` and shared server copy | REUSE FAIL-CLOSED PRINCIPLE | Existing authority is policy- and tenant-scoped and revalidated. Company Brain authority proposals remain separate from grants; repeated case approvals cannot create a standing rule. No changes are made to the execution authority engine in G0. |
| `autopilot_execution_claims` / awaiting approval primitives | REJECT AS COMPANY AUTHORITY STORE | These are execution/idempotency receipts for existing reminder flows, not founder Company Brain decisions or standing authority grants. Reusing them would collapse distinct concepts. |
| `dw_evidence_items` | REUSE SCHEMA CONCEPTS, NO MIGRATION | Existing schema preserves tenant, trust/admission status, digest, provenance, and derived-from lineage. G0 mirrors these concepts in deterministic local objects. Production persistence waits for a later gate. |
| `dw_memory_claims` and `dw_memory_tombstones` | EXTEND CONCEPTUALLY, NO MIGRATION | Existing structures prove tenant-scoped memory and tombstone semantics. They are client/invoice-scoped and not sufficient for company/global policy, role, conflict, or founder-decision objects. |
| DW Intelligence run/proof models | REUSE TYPED-CONTEXT STYLE | Existing proof objects keep canonical facts, evidence, interpretation, memory, precedent, and authority distinct. G0 exports a closed typed Company Brain context rather than an untyped prompt block. |
| System Brain structural audit | REJECT FOR INGESTION | System Brain maps code routes/dependencies and explicitly avoids tenant rows. Company Brain ingests tenant-provided operating material; merging the two would violate both scopes. |
| Supabase RLS and composite tenant FKs | REUSE REQUIREMENT | Every future persisted Company Brain row must carry tenant identity and tenant-safe relationships. G0 enforces tenant equality in memory and tests but creates no hosted schema. |
| Node `node:test` suite | REUSE | The repo's deterministic unit-test convention needs no new framework or dependency. |
| Existing UI | REJECT CHANGES | G0 is an architecture proof. No Company Brain UI or product redesign is needed. |

## Selected G0 shape

The smallest semantically correct location is `src/lib/companyBrain/`: a pure, deterministic domain/kernel module plus a fixture-ingestion adapter. It is independent of browser UI and provider/network clients. Tests live in `tests/companyBrainG0.test.mjs`; controlled materials live in `fixtures/company-brain/acme-ar-ops/`.

The kernel will:

1. validate tenant-scoped Sources, Artifacts, Claims, conflicts, decisions, and authority objects;
2. build active snapshots from root provenance and revocation state;
3. detect the fixture's scoped late-fee conflict without confidence-based winner selection;
4. produce a structured operating-model proposal;
5. apply explicit founder decisions only to the named scope;
6. refuse authority promotion from repeated approvals;
7. answer the four Ask DW proof questions through a narrow typed adapter;
8. expose typed, provenance-carrying Company Brain context to DW Intelligence;
9. provide no canonical money write surface.

## Explicit non-goals

- No live Drive, CRM, email, Stripe, QBO, Xero, or Supabase integration.
- No production schema or RLS migration.
- No autonomous external action.
- No Company Brain UI.
- No modification of the frozen R0 ontology, invariants, ownership, or provenance doctrine.
- No M2H work.
