# Duewatch Presence System — Merged Engineering Spec v1.2

**For:** Claude Code
**Reconciles:** PR #15 + Kimi's motion timing + GPT's intelligence layer + v1.2 motion reconciliation (landing page alignment)
**Date:** July 23, 2026
**Status:** Implemented — PR #18 (v1.1 core) + motion reconciliation PR (v1.2 changes)

This file lives in the repo from v1.2 onward so the spec and the shipped code stop drifting apart — v1.1 only ever existed as a pasted document, never a tracked file.

---

## Changelog from v1.1 (this revision)

| Issue | Fix |
|---|---|
| Active/Error shake on entry read as alarm, not calm competence | **Removed entirely.** No shake on any state, ever. Attention comes from color and pulse only. `activeShake` keyframe and both header animation rules deleted. |
| Error pulsed forever until a human intervened — nagging, becomes background noise | **Error now settles.** One entry-pulse sequence (3 cycles at 0.8s ≈ 2.4s: dot pulse, dot glow, card border pulse all finite via `animation-iteration-count: 3` + `forwards`), then holds a static solid-red dot + red border tint. State stays Error until the real problem resolves — only the *motion* stops. |
| JourneyBar's "Signature" stage read as a different product than the landing page's own language | **Renamed to "Awaiting signature"** (display label only — the internal stage id `signature` in `journey.js`/`JourneyBar.jsx` is unchanged, and no stages were added; the landing page's extra beats — Approved, Signing, Sending, Evidence recorded — are sub-moments of the Approve & Send interaction for the landing page's own animated demo, not real JourneyBar stages). |
| (Found during this pass, not spec'd) `.cognitive-ring .ring-core` centering lived only inside its keyframe | Added a static `transform: translate(-50%, -50%)` base so the dot stays centered if the animation is ever disabled (reduced motion). |
| (Found during this pass, not spec'd) Contextual/Active/Error `::after` ripple/glow elements had no non-animated opacity, so reduced-motion left a permanent full-opacity halo behind the dot | `presence-reduced-motion.css` now explicitly sets `opacity: 0` on those `::after` elements. |
| Icon bug from PR #15 (`Bot` rendering blank) | Re-verified for `PresenceIndicator.jsx` by actually bundling `lucide-react` through this project's real Vite pipeline (not a hand-drawn SVG mirror, which is what missed it the first time) — the icon rendered correctly in that test. Could not be verified against the actual production deployment (no network access to it from this environment); if it's still broken live, the bug is specific to that deployment, not the import/component code. |

---

## 1. Philosophy

Every motion communicates presence. The founder should always know: Is Duewatch here? Is it working? Is it waiting for me? Does it need me? Is everything handled? (Unchanged from v1.1.) v1.2 sharpens this: attention comes from **color and pulse**, never from jitter — shake reads as alarm, which contradicts "everything is handled."

---

## 2. Design System (Light Theme — Locked)

Unchanged from v1.1. Tokens are implemented scoped to `.presence-card` in `src/styles/presence.css` rather than global `:root`, since the app's existing `--green`/`--red`/`--amber`/`--border` tokens (`index.css`) use different hex values for other UI — scoping avoids silently changing colors elsewhere.

```css
.presence-card {
  --p-green: #22A565;
  --p-brand: #DA7756;
  --p-brand-tint: #FBEEE8;
  --p-amber: #E0930C;
  --p-red: #DC2626;
  --p-navy: #231F1B;
  --p-gray: #6B6B6B;
  --p-border: #E7DFD1;
}
```

**Card container:** white background, 1px solid `--p-border`, 14px radius, 18px padding, `0 1px 3px rgba(35,31,27,0.04)` shadow.

**State-specific border tints (unchanged):**
- Error: `rgba(220, 38, 38, 0.35)` — now a settled static tint, not paired with an infinite pulse
- Active: `rgba(224, 147, 12, 0.4)`
- Celebratory: `rgba(34, 165, 101, 0.35)`
- Contextual: `rgba(224, 147, 12, 0.35)`

---

## 3. The Seven States — Locked Names, Locked Precedence

| Priority | State | Emotion | Motion | Color | When |
|---|---|---|---|---|---|
| 1 | **Celebratory** | "We did it" | 0.6s bounce + green glow | Green #22A565 | Payment received, milestone hit |
| 2 | **Error** | "Fix this" | Entry: ~2.4s pulse + glow + card border pulse (3 cycles, then stops). Settled: solid red dot + red border tint, no loop. | Red #DC2626 | Bounced email, delivery failure |
| 3 | **Active** | "Urgent" | 1s pulse + glow, loops while true | Amber #E0930C | Critical overdue, general urgency |
| 4 | **Contextual** | "Your turn" | 1.5s pulse + ripple | Amber #E0930C | Signature needed, review, edit |
| 5 | **Cognitive** | "I'm thinking" | Dual-ring rotation + core pulse | Brand #DA7756 | Manual actions only (see §4.2) |
| 6 | **Resting** | "All good" | 10s breathe (barely perceptible) | Green #22A565 | Autopilot on, all healthy |
| 7 | **Off** | "Paused" | None — static | Gray #6B6B6B | Autopilot disabled, must stay visible |

**Precedence rule:** `Celebratory > Error > Active > Contextual > Cognitive > Resting > Off`

No shake anywhere in this table (v1.2).

---

## 4. State Definitions

### 4.1 Resting — unchanged from v1.1.

10s breathe (opacity 0.5→1→0.5, scale 1→1.12→1) on the status dot only.

### 4.2 Cognitive — unchanged from v1.1.

Dual-ring rotation (2.5s outer, 3s inner reverse) + core pulse (2s). Manual actions only today (`SignatureCard`'s Approve & Send, `InvoiceDetailPanel`'s `sendReminder()`); the daily cron never surfaces this. Hard cap: never longer than 5s in the UI regardless of real operation length (`usePresence.js`'s `COGNITIVE_MAX_MS`).

`.cognitive-ring .ring-core` now has a static `transform: translate(-50%, -50%)` base (v1.2 fix) so centering survives the animation being disabled under reduced motion.

### 4.3 Contextual — unchanged from v1.1.

1.5s pulse + ripple on the amber status dot. The only attention-grabbing motion besides Error's brief entry moment.

### 4.4 Active (v1.2: shake removed)

**When:** General attention needed — critical overdue invoices, non-delivery issues short of a hard bounce.

**Visual:**
- Status dot: 10px amber circle, 1s pulse + glow, loops continuously while the condition is true
- Card border: `rgba(224, 147, 12, 0.4)`
- ~~Shake on entry~~ — removed in v1.2. No jitter anywhere in the system.

**Copy:** unchanged from v1.1 ("Autopilot needs attention" / "{N} reminder needs review" / "One item needs your review.")

### 4.5 Error (v1.2: settles instead of pulsing forever)

**When:** Specific delivery failure — email bounced, address invalid.

**Visual:**
- On entering Error: one attention sequence — dot pulse + glow + card border pulse, 3 cycles at 0.8s (~2.4s total), then **stop**.
- After settling: solid red status dot, card keeps its red border tint (`rgba(220, 38, 38, 0.35)`) — no looping animation.
- The state remains Error — still red, still clearly needs attention — until the underlying problem is actually resolved. Only the motion stops, not the state.
- ~~Shake on entry~~ — removed in v1.2, same as Active.

**Why:** an animation that loops forever until a human intervenes is nagging, and people stop seeing it — the same reason a car alarm that never stops becomes background noise.

**CSS (as shipped, `src/styles/presence.css`):**
```css
.presence-error .status-dot {
  background: var(--p-red);
  animation: activePulse 0.8s ease-in-out 3 forwards;
}
.presence-error .status-dot::after {
  /* glow */
  animation: activeGlow 0.8s ease-in-out 3 forwards;
}
.presence-error.presence-card {
  border-color: rgba(220, 38, 38, 0.35);
  animation: errorBorderPulse 0.8s ease-in-out 3 forwards;
}
```
`animation-iteration-count: 3` + `forwards` holds the final keyframe (which resolves to the settled, non-pulsing appearance) once the entry sequence finishes — no JS timer needed.

**Copy:** unchanged from v1.1.

### 4.6 Celebratory — unchanged from v1.1.

0.6s bounce + green glow, auto-dismisses after exactly 10s.

### 4.7 Off — unchanged from v1.1.

Static gray dot, 0.4 opacity, must stay visible.

---

## 5. The "Advancing" Transition (JourneyBar)

Unchanged from v1.1 in behavior — already satisfied by PR #15's existing JourneyBar (one-shot ~1.6s flowing fill, never replays on mount, implemented with React state/refs rather than DOM queries). No `JourneyBarV2` fork was created for v1.1 or v1.2.

**v1.2 stage naming (display only):**

| Keep (app) | Reason |
|---|---|
| Checked | Real stage — Autopilot evaluated this invoice |
| Drafted | Real stage — a reminder was prepared |
| **Awaiting signature** (renamed from "Signature") | Matches the product's own locked language everywhere else (the `awaiting_signature` table, the "Awaiting Your Signature" section header) |
| Sent | Real stage |
| Paid | Real stage |

The internal stage id (`signature`, used throughout `src/lib/journey.js` and `JourneyBar.jsx`) is unchanged — this is a label-only rename. No stages were added. The landing page's extra beats (Approved, Signing, Sending, Evidence recorded) belong to the landing page's own animated demo sequence, not the app's JourneyBar.

---

## 6. Card Structure (Sidebar Footer) — unchanged from v1.1.

---

## 7. When to Trigger Each State — unchanged from v1.1 in intent. As shipped (`usePresence.js`), every trigger maps to a real app signal:

- Celebratory: a real payment write that closes an invoice (`markPaid`, or `recordPayment` when it results in `willBePaid`)
- Error: `events` rows with `lifecycle_state: 'error'` (written by the scheduler on a failed send)
- Active: invoices ≥15 days overdue (existing `effectiveStatus` "critical"/"final_notice" threshold). `autopilotUnexpectedlyPaused` has no real signal anywhere in this codebase and stays `false` rather than being faked.
- Contextual: `awaitingSignature.length`
- Cognitive: real in-flight async work (Approve & Send, `sendReminder()`) — never the daily cron, which is invisible to a live human by design
- Resting/Off: `autopilotEnabled`

---

## 8. Click Behavior — unchanged from v1.1, with one implementation note: Active's "attention modal" and Error's "client email edit modal" don't exist yet anywhere in the app. Both currently route to the closest real existing page (`/invoices`, `/activity`) instead of a fabricated modal.

---

## 9. Reduced Motion (Required)

All transform/loop animations disabled under `prefers-reduced-motion: reduce`; every state stays fully distinguishable by color/fill alone. v1.2 additions to what v1.1 already covered:

- `.presence-contextual .status-dot::after`, `.presence-active .status-dot::after`, `.presence-error .status-dot::after` now get an explicit `opacity: 0` override — previously, disabling their animation left them at the CSS-initial opacity of 1, showing a permanent static halo/ring that nobody designed.
- The now-removed shake rules (`.presence-active .presence-header`, `.presence-error .presence-header`) are gone from the reduced-motion override list along with the base rules, since there's no shake left to disable.

---

## 10. Accessibility — unchanged from v1.1 (screen reader `role="status" aria-live="polite"` + per-state announcement text). Focus management (compose modal, attention/error banner) remains only partly implemented, since those target UI elements don't exist in the app yet.

---

## 11. Performance — unchanged from v1.1. `will-change` scoped to the real animating selectors (`.presence-resting .status-dot`, `.cognitive-ring .ring-outer`, etc.), never a wildcard.

---

## 12. File Structure (as shipped)

```
src/
  features/
    PresenceIndicator.jsx
    PresenceSystem.jsx
  hooks/
    usePresence.js
  lib/
    presence.js          # config object — kept in src/lib/ (this project's
                          # existing convention for plain JS logic modules),
                          # not src/types/ as v1.1 suggested; there is no
                          # src/types/ anywhere in this codebase and no TS
  styles/
    presence.css
    presence-reduced-motion.css
```

`CognitiveCompose.jsx` from v1.1's file list was not built — the spec named it but gave no interaction detail for the "line-by-line draft experience," and building it would mean inventing UX rather than following a spec. Still open.

---

## 13. Naming Lock

Unchanged from v1.1 — these names are immutable without CPO approval:

| State | Never Call It |
|---|---|
| Resting | Ambient, Idle, Default |
| Cognitive | Thinking, Processing, Loading |
| Contextual | Waiting, Pending, NeedsYou |
| Active | Urgent, Alert, Warning |
| Error | Failed, Bounced, Problem |
| Celebratory | Success, Win, Done |
| Off | Disabled, Inactive, Hidden |

JourneyBar's "Awaiting signature" rename (§5) is a display label, not a Presence System state name, and is not subject to this lock table.

---

*Spec version: 1.2*
*Reconciles: PR #15 + Presence System v1.0/v1.1 + Intelligence Layer + landing page motion reconciliation*
*Author: Kimi (CPO), amendments implemented by Claude Code*
*For: Session 7.5 — scales to Session 8+*
