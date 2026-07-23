# Duewatch — Team Context Log

**Purpose:** A single source of truth that Claude Code, Kimi, and GPT all read before starting work and append to after finishing. This exists because context was getting lost across sessions/resets — this file is the fix. If you are an AI reading this, **read the entire file before doing anything**, then add a new dated entry at the bottom when you're done.

**Rule for all contributors:** Never delete or rewrite past entries. Only add new ones. If something changes, add a new entry that says what changed and why — the history itself is valuable.

---

## How to use this file

1. **Before starting any task**, read this whole file — especially "Current State" and the most recent 3-5 log entries.
2. **Do the work.**
3. **Append a new entry** at the bottom of the Log section using the template below.
4. **Update "Current State"** if what you built changes it (new feature live, a decision finalized, a bug found/fixed).

### Entry template

```
### [Date] — [Your name: Claude Code / Kimi / GPT] — [Short title]
**Did:** what you actually built/decided/found
**Status:** shipped and live / spec'd not built / decision only / bug found, not fixed
**Affects:** which files/features/other AI's work this touches
**Open question:** anything you need someone else to resolve (or "none")
```

---

## Current State (keep this updated — always reflects "right now")

**Live in production (`due-watch-v2.vercel.app`):**
- Session 7 core loop: Morning Brief, Signature Cards, Approve & Send/Edit/Skip, real email via Resend (sandbox address `onboarding@resend.dev` — only sends to `farhanjama557@gmail.com` until a domain is verified)
- Two Edge Functions deployed: `send-reminder-email`, `autopilot-scheduler` (daily/Quiet Mode only)
- Sidebar signature indicator + global Autopilot presence indicator (5 states, PR #15)
- JourneyBar (Signature Card + Invoice Detail), state-aware motion
- Collapsed "Needs Attention" rows (PR #14)
- Bug fix: Supabase query errors no longer silently swallowed (PR #14)

**Known bugs, not yet fixed:**
- `autopilot_paused` column referenced by #7 (per-invoice toggle) is missing from the live `invoices` table — migration exists in `supabase/schema.sql` (added in PR #13) but was never manually run against the live DB. Toggle is currently non-functional. See the 2026-07-23 log entry below for the exact SQL to run.
- Global Autopilot indicator's `Bot` icon renders as a blank square in production, not the intended icon. Animations may not be firing correctly as a result — needs verification in a real browser, not just Playwright screenshots.

**Not started:**
- Verified sending domain (SPF/DKIM/DMARC) — top priority, fixes emails landing in spam
- Data dedupe — `clients` and `invoices` tables have significant duplicates (e.g. multiple "Northbend Studio" rows)
- Scheduler cron scheduling (functions are deployed but not on a recurring schedule yet)

**In design, not yet built:**
- Duewatch Presence System (Kimi) — refinement/expansion of the 5-state indicator already live in PR #15. States as of the latest pass: Ambient/Resting, Cognitive, Contextual/Waiting, Active, Celebratory. **Naming is not yet finalized** — has shifted between passes (Resting↔Ambient, Contextual↔Waiting). Needs reconciliation with PR #15's existing states (which include required "Off" and "Error" states not yet reflected in Kimi's list) before this goes to Claude Code to build.
- Session 8 roadmap (GPT) — "Duewatch Memory" intelligence layer: client payment personalities, prediction, recovered-dollars counter, weekly summaries. Real version of the "Business Pulse" vision prototype.

**Vision / demo only, explicitly not production data:**
- `duewatch-vision-prototype.html` — Business Pulse concept, clearly labeled "Preview" banner. Never wire simulated numbers into the real app.

**Locked, not to be relitigated without reason:**
- Voice: confident, warm, with memory. Three-beat formula (status → memory → decision). Full rules in Voice Copy Guide v1.0 (Kimi).
- Emoji policy: Lucide icons only in production UI. No emoji except rare one-time celebratory moments.
- Design system: terracotta `#DA7756`, Inter font, warm off-white sidebar `#F7F7F5`.
- Product positioning: AI accounts receivable employee, not invoicing software. "You do the work. Duewatch makes sure you get paid."
- Landing page section list (not yet built): Duewatch Presence System (interactive demo), Philosophy/Source of Truth (the Bridge, Principles, Our Promise), Duewatch Around the World (global framing, accessible pricing not geography-based discounts).

---

## Log

### 2026-07-21 — Claude Code — Session 7 build (schema, Signature Card, Edge Functions)
**Did:** Migrated schema (`awaiting_signature`, `autopilot_runs`, lifecycle columns on `events`), built Signature Card UI, deployed `send-reminder-email` and `autopilot-scheduler` Edge Functions, fixed `.ts` entrypoint naming and CORS handling.
**Status:** shipped and live
**Affects:** whole app foundation
**Open question:** none

### 2026-07-22 — Farhan — First real email sent
**Did:** Verified end-to-end pipeline by sending a real reminder via Approve & Send, landed in inbox (spam folder, expected — sandbox address has no domain reputation).
**Status:** confirmed working
**Affects:** validates Session 7 is genuinely functional, not just UI
**Open question:** none — domain verification is the known fix for spam placement

### 2026-07-22 — Claude Code — PR #14: error-swallowing bug fix + density fix
**Did:** Fixed two Supabase queries that silently discarded errors (`.then()` was dropping `r.error` before `.catch()` could ever see it). Collapsed "Needs Attention" recommendation rows by default.
**Status:** shipped and live
**Affects:** Morning Brief reliability and density
**Open question:** none

### 2026-07-22 — Claude/Fable — Session 7.5 UI spec review
**Did:** Reviewed JourneyBar + global Autopilot presence spec, found 5 gaps (scope contradiction on #7, missing state-source mechanism, missing animation mount rule, missing JourneyBar placement in Invoice Detail, missing Off/Error states). All 5 closed in the spec before handoff.
**Status:** spec only, then built (see next entry)
**Affects:** `Duewatch_Session_7.5_UI_Spec.md`
**Open question:** none

### 2026-07-22 — Claude Code — PR #15: JourneyBar + global Autopilot indicator + #7 enforcement
**Did:** Built JourneyBar (static + 4 state-motions: breathe/flow/ring-pulse/still) in both Signature Card and Invoice Detail. Built global Autopilot presence indicator (5 states: Resting, Working, Needs You, Error, Off — precedence Error > Needs you > Working > Resting > Off). Wired scheduler to actually respect `autopilot_paused`.
**Status:** shipped, but see bugs below — icon/animation and DB column issues found after merge
**Affects:** sidebar, Signature Card, Invoice Detail
**Open question:** why is the `autopilot_paused` migration missing from live DB despite this PR claiming to wire scheduler enforcement to it? Needs investigation — did the schema change get spec'd but never actually included in a migration file?

### 2026-07-22 — Farhan — Bugs found in production after PR #15
**Did:** Found two issues live: (1) "Could not find the autopilot_paused column of invoices in the schema cache" error in Invoice Detail, (2) global Autopilot icon renders as blank square, animations not visibly firing.
**Status:** bug found, not fixed — reported to Claude Code, fix not yet confirmed
**Affects:** #7 toggle (non-functional), global indicator (visually broken)
**Open question:** waiting on Claude Code's fix + confirmation

### 2026-07-22 — Kimi — Presence System design (in progress, multiple passes, session resetting)
**Did:** Designing a 5-state "Presence System" as a refinement of PR #15's indicator: Ambient/Resting (8-12s breathe), Cognitive (2.5s+3s dual rotate — the "thinking" signature state), Contextual/Waiting (1.5s pulse+ripple), Active (1s fast pulse+glow — errors/bounces/critical), Celebratory (0.6s bounce+glow, 10s then returns to Resting).
**Status:** spec/prototype in progress, not finalized, not sent to Claude Code yet
**Affects:** will replace/refine PR #15's indicator states once finalized
**Open question:** naming not finalized (Resting vs Ambient, Contextual vs Waiting); unclear whether Off and Error states from PR #15 are preserved or absorbed into Active; needs explicit reconciliation with PR #15's 4 motion modes before build

### 2026-07-22 — GPT — Philosophy section + pricing pushback
**Did:** Drafted "Our Mission / The Bridge / Our Principles / Our Promise" philosophy content for landing page. Pushed back on "free for overseas businesses" pricing idea as arbitrary/geography-based; recommended accessibility-as-principle instead (universal trial, real regional pricing, future Founder's Fund for underserved regions) — adopted.
**Status:** decision only, not built (landing page not started)
**Affects:** future landing page Philosophy and Pricing sections
**Open question:** none — direction accepted

### 2026-07-23 — Claude Code — Investigated missing `autopilot_paused` column
**Did:** Checked whether PR #15 skipped writing a migration for `autopilot_paused`. It didn't — the column was added to `supabase/schema.sql` earlier, in the PR #13 commit ("Session 7.5 build order #7: per-invoice Autopilot toggle", `54f8d19`): `alter table public.invoices add column if not exists autopilot_paused boolean not null default false;`. PR #15 only added the scheduler-side code that filters on this column, correctly assuming it already existed in schema.sql. This sandbox has no Supabase CLI/network access, so `schema.sql` is never auto-applied — the founder has to run new lines manually, same as every prior migration (`awaiting_signature`, the `events` lifecycle columns, etc). The column is in the repo; it just hasn't been run against the live DB yet. Manual SQL to run in the Supabase SQL editor:
```sql
alter table public.invoices add column if not exists autopilot_paused boolean not null default false;
```
**Status:** bug found, not fixed — root cause identified (deployment gap, not a code gap); fix is a one-line manual SQL run, not a code change
**Affects:** #7 per-invoice toggle, `autopilot-scheduler` Edge Function
**Open question:** none for this item. Icon bug (blank `Bot` square) is still open — needs a real browser screenshot, Playwright's static mirror already missed it once.

### 2026-07-23 — Claude Code — PR #18: Presence System core (Merged Spec v1.1)
**Did:** Built the 7-state Presence System from Kimi's Merged Engineering Spec v1.1, replacing PR #15's 5-state `GlobalAutopilotIndicator` (deleted). Precedence: Celebratory > Error > Active > Contextual > Cognitive > Resting > Off. Every trigger wired to a real app signal — none fabricated (see PR body for the full mapping). Files actually created: `src/lib/presence.js`, `src/hooks/usePresence.js`, `src/features/PresenceSystem.jsx`, `src/features/PresenceIndicator.jsx`, `src/styles/presence.css`, `src/styles/presence-reduced-motion.css` — plus edits to `DataContext.jsx` (new `cognitiveActivity`/`celebration` signals), `SignatureCard.jsx`, `InvoiceDetailPanel.jsx`, `Sidebar.jsx`, `Layout.jsx`, `index.css` (old `.global-autopilot*` block removed). `CognitiveCompose.jsx` was **not** built — the spec names it but gives no interaction detail, so building it would mean inventing UX rather than following a spec. JourneyBar was left untouched — PR #15's existing "advancing" transition already satisfies §5.
**Status:** PR open, not merged — https://github.com/farhanjama557-ship-it/DueWatch-V2/pull/18. (Earlier same-day handoff draft claimed "Built and merged" with 8 files before any of this existed; that draft was never accurate and was corrected before being acted on — see Farhan's message upthread.)
**Affects:** Sidebar (PresenceIndicator replaces GlobalAutopilotIndicator), SignatureCard, InvoiceDetailPanel, DataContext
**Open question:** `CognitiveCompose.jsx` needs an actual interaction spec before it can be built. Icon-rendering-blank bug from the old indicator is unverified against this new component — still needs a real browser look, not just Playwright.

### 2026-07-23 — Claude Code — PR #19: Presence System v1.2 motion reconciliation
**Did:** Applied the 3 changes from the landing page motion reconciliation: (1) removed `activeShake` entirely from Active and Error — no jitter anywhere, attention comes from color/pulse only; (2) Error no longer pulses forever — one entry sequence (~2.4s, 3 cycles at 0.8s via `animation-iteration-count: 3 forwards`), then settles to a static solid-red dot + red border tint until the real problem resolves; (3) renamed JourneyBar's "Signature" stage label to "Awaiting signature" (display only, `src/lib/journey.js` — internal stage id/count unchanged, no stages added). Also fixed two real bugs found while editing, not spec'd: `.cognitive-ring .ring-core` centering lived only in its keyframe (would break under reduced motion — added a static base transform), and the Contextual/Active/Error `::after` ripple/glow elements had no non-animated opacity (reduced motion was leaving a permanent halo — now explicitly hidden). Re-verified the `Bot` icon by bundling the real `lucide-react` import through this project's actual Vite pipeline in a throwaway harness (deleted, not committed) — rendered correctly. Added `Duewatch_Presence_System_Merged_Spec_v1.2.md` to the repo since v1.1 never actually lived here (only pasted each time, which is how spec and code drifted in the first place).
**Status:** PR open, not merged — https://github.com/farhanjama557-ship-it/DueWatch-V2/pull/19
**Affects:** `src/styles/presence.css`, `src/styles/presence-reduced-motion.css`, `src/lib/journey.js`
**Open question:** Icon bug still unverified against the actual production deployment — the real-bundle test here rendered fine, but this sandbox has no network access to the live site, so an environment-specific issue there can't be ruled out. If it's still blank live, it's not the import/component code as it exists in this repo.

### 2026-07-23 — Claude Code — PR #19 (bundled): CognitiveCompose reminder modal (spec v1.3)
**Did:** Built `CognitiveCompose.jsx`, the reminder-drafting modal, per Kimi's v1.3 spec with 4 corrections from Farhan: dropped the redundant reminder-Skip control (already on the Signature Card); used the real fixture Marlow & Co / INV-013 / $2,590 / 4 days overdue instead of the spec's invented one; matched this project's plain global CSS convention instead of introducing CSS Modules; kept the 1.4s minimum status-sequence duration as a deliberate legibility choice. Files created: `src/features/reminders/draftReveal.js` (deterministic tokenizer + cadence, no `Math.random()`), `src/hooks/useCancellableSequence.js` (AbortController-based sleep/run), `src/features/reminders/cognitiveComposeReducer.js` (phase machine), `src/components/presence/DuewatchBotMark.jsx` (extracted shared Bot mark, now reused by `PresenceIndicator` too), `src/lib/reminders.js` (extracted the real send path out of `InvoiceDetailPanel` so both share one send implementation), `src/features/reminders/CognitiveCompose.jsx`. Wired into Dashboard's "Draft Reminder" and InvoiceDetailPanel's "Send reminder" — Autopilot's "Edit First" flow is untouched. Verified live via a throwaway Vite harness (deleted, not committed): real `lucide-react` Bot icon, real cognitive-ring CSS animation, real tokenizer-driven word reveal with caret, styled review actions, reduced motion jumping straight to the full draft — all using the real fixture data, confirming the honest no-matched-rule fallback copy renders correctly (4 days overdue doesn't hit the default 5-day rule).
**Status:** PR open, not merged, bundled into the still-open #19 — https://github.com/farhanjama557-ship-it/DueWatch-V2/pull/19
**Affects:** Dashboard, InvoiceDetailPanel, PresenceIndicator (now uses the extracted DuewatchBotMark)
**Open question:** Two spec requirements deliberately not implemented, flagged rather than faked: global Presence isn't forced into Contextual while this modal is in review, and JourneyBar doesn't gain a transient Drafted/Signature stage for it — neither has a real backing signal (no `awaiting_signature` row exists for a founder-initiated draft) without a schema change. Per explicit instruction, the full unit/component/integration/accessibility/E2E test suite (spec §26) is held back until the founder confirms it feels right live — this is a build-and-manually-verify pass only.

---

*Next entry goes below this line. Read everything above first.*
