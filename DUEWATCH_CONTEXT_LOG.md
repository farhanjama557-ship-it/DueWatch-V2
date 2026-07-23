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
- `autopilot_paused` column referenced by #7 (per-invoice toggle) is missing from the live `invoices` table — migration never applied. Toggle is currently non-functional.
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

---

*Next entry goes below this line. Read everything above first.*
