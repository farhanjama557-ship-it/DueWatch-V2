# Pulse 1672×941 reconstruction — design QA

## Evidence

- Locked target: `C:\Users\Owner\Downloads\40cc6e33-6fc2-4490-9e96-5f43041a5e57.png`
- Target-density composition render: `visual-harness/pulse-target-density-composition-1672x941.png`
- Final truthful ACTIVE render: `visual-harness/pulse-truthful-active-final-1672x941.png`
- Final truthful OFF render: `visual-harness/pulse-truthful-off-final-1672x941.png`
- Final ACTIVE/OFF comparison: `visual-harness/pulse-active-off-final-comparison.png`
- Overlay: `visual-harness/exact-final-overlay.png`
- Difference map: `visual-harness/exact-final-diff.png`
- Viewport: 1672 × 941 CSS pixels
- Target app crop: 1672 × 861 after removing the 80-pixel browser frame

The target crop and implementation render were compared at the same 1:1
pixel scale. The isolated `?fixture=exact` route supplies the target's sample
density without changing production authority/data behavior. ACTIVE and OFF
remain the truthful product fixtures and use the same invoice facts.

## Measured geometry

- Sidebar: x 0–226, width 226.
- Main workspace: x 226–1398, width 1172.
- Right rail: x 1398–1672, width 274.
- Main content: x 257–1373, width 1116.
- KPI grid: y 100.5–236.5, height 136.
- Working strip: y 248.5–329.5, height 81.
- Middle row: y 341.5–648.5, height 307.
- Assistant panel: y 662.5–816.5, height 154.
- Rail sections: y 15–358.3, 366.3–598.4, and 606.4–836.7.
- Sidebar profile: y 733.9–778.1.

These boundaries match the locked target to within roughly 0.5–3 pixels at
the major shell and region edges.

## Pixel comparison

- Baseline mean absolute RGB error: 19.3793.
- Final mean absolute RGB error: 14.1494.
- Baseline pixels with max-channel delta over 24: 15.56%.
- Final pixels with max-channel delta over 24: 13.02%.

The remaining delta is dominated by semantic copy, the target's illustrative
sparkline shapes, the repository's existing logo/icon vocabulary, and the
fact that production truth intentionally replaces unsupported target claims.

## Findings

- P0: none.
- P1: none.
- P2: none after iteration.
  - Resolved the shell widths, horizontal insets, target vertical cadence,
    six-card exact-density KPI band, middle-card proportions, compact
    assistant placement, continuous dark rail, and sidebar/profile rhythm.
  - Replaced the hand-built assistant SVG with the approved transparent
    full-body raster mascot while preserving panel height and aspect ratio.
  - Preserved the existing production-safe table title/reason vocabulary
    where the target contains claims the product cannot currently prove.
- P3 follow-up notes:
  - The locked target uses detailed data sparklines; the local reconstruction
    uses the repository icon system rather than introducing a new chart
    dependency for a screenshot-only fixture.
  - The repository's shield LogoMark remains in place rather than inventing
    a new brand asset from a small screenshot crop.

## Truth and safety checks

- ACTIVE and OFF use identical invoice, client, reminder, event, and pending
  approval facts. Only Autopilot-enabled state differs.
- ACTIVE shows two reminders this week and Evidence shows the same two
  reminder events, linked to INV-1045 and INV-1048 with matching timestamps.
- OFF retains the existing pending approval by design: disabling Autopilot
  changes `autopilot_settings.enabled`; pending `awaiting_signature` rows are
  loaded independently and remain founder-visible.
- No authority, execution, Supabase, migration, RLS, grant, or hosted
  environment behavior changed.
- `src/lib/pulseAuthority.js` is unchanged.
- JavaScript tests: 556/556 passed.
- Production Vite build: passed.

## Sparse-data composition closing pass

- The visit delta is folded into the operating strip and retains the same
  real Checked/Drafted values; it no longer creates a target-inconsistent
  full-width row.
- The four production KPIs occupy the same 136-pixel target band without
  inventing the target's unsupported metrics or trend history.
- The overdue and Due Soon cards preserve the target's 307-pixel region with
  their real three-row/two-row data and truthful invoice links.
- The bottom panel uses four supported current facts (open invoices,
  outstanding balance, overdue invoices, and reminders sent this week), the
  unchanged Presence copy/action, and the canonical production mascot.
- The rail now retains the target's three-card hierarchy by grouping the real
  authorization state and real due-soon facts into one operations card; its
  Evidence card shows three recent real events and links to the complete feed.
- At 1672×941, target-density and truthful ACTIVE share the same y-boundaries:
  KPI 100.5–236.5, working strip 248.5–329.5, middle row 341.5–648.5,
  assistant 662.5–816.5. Truthful ACTIVE has no overflow or browser errors.
- Final ACTIVE/OFF comparison found no P0, P1, or P2 difference. Both states
  retain those exact boundaries and the same invoice, due-soon, approval,
  Evidence, KPI, and assistant-snapshot facts. OFF changes only the observed
  status copy to `Autopilot is off. Nothing is scheduled.`; the independent
  pending approval remains visible in both states, as production behavior
  requires. Neither render contains an exact-fixture node or demo fact.

## Exact-fixture production isolation audit

- The production HTML entry loads only `/src/main.jsx`; that entry renders
  `AuthProvider` and `App`, and contains no visual-harness import.
- The root `vite.config.js` contains only the production React configuration.
  The exact fixture has its own separate `visual-harness/index.html`,
  `visual-harness/main.jsx`, and `visual-harness/vite.config.js` entry graph.
- Production source roots (`index.html`, root `vite.config.js`, `package.json`,
  and `src/`) contain no `ExactTargetLayer`, `fixture=exact`, `exact-target`,
  or `visual-harness` reference.
- The built `dist/` output contains none of the exact-fixture activation
  strings or demo facts: `fixture=exact`, `ExactTargetLayer`, `exact-target`,
  `$68,400`, `22% vs last month`, `monitoring 17 invoices`,
  `13 handled automatically`, `Payment plan request`,
  `Write-off recommendation`, `Autopilot impact this month`, or
  `View full schedule`.
- The production mascot is present in the build as the fingerprinted
  `duewatch-assistant-*.png` asset because `DuewatchAssistant.jsx` imports it
  from `src/assets/`. No exact-fixture data accompanies it.
- Normal production Pulse remains `Layout` → `DataProvider` → `Dashboard` →
  `useData()` / `evaluatePulseAuthority()`. The harness substitutes its mocks
  only through its separate Vite config.
- `src/lib/pulseAuthority.js` has the same Git blob hash in the working tree
  and at HEAD (`41fad7a27e3fe597105ce07535087decac37a83e`).
- Fresh 1672×941 ACTIVE/OFF browser captures contained zero `exact-*` nodes,
  four truthful KPI cards, two matching reminder events, identical invoice,
  due-soon, and approval facts, no overflow, and no Vite error overlay.

final result: passed
