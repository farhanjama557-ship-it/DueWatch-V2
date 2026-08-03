# Duewatch Pulse — Visual Reference

## What this is

`docs/design/duewatchpulseuiexport.html` is the single future **visual** north star for the Duewatch Pulse dashboard. It **supersedes every earlier dashboard HTML reference** used in this project (north-star-corrected exports, prior mockups, prior "approved" screenshots) — if an earlier reference disagrees with this file, this file wins.

## What it is not

- **It contains fictional mock data only.** Every client name, invoice number, dollar amount, activity line, and evidence count in the file is invented for layout demonstration. None of it reflects real Duewatch data, and none of it should be treated as a target number or a real scenario to replicate.
- **Its copy is not locked production copy.** Headlines, subtitles, button labels, and narrative sentences in the file are placeholder text to show tone and density — not final, approved strings to ship verbatim.
- **Its approval message is only a visual example.** The sample reminder text shown in the "Needs your approval" card demonstrates layout and length, not an approved message template.
- **Cash Flow is an inactive visual placeholder only.** The disabled "Cash Flow" nav item with its "Later" chip shows how a not-yet-built feature should look in the sidebar — it is not a signal to build Cash Flow, and its presence here doesn't imply scope.
- **It does not define database behavior or supported functionality.** Nothing in this file specifies schema, business logic, validation rules, API behavior, or what the product actually does. It is layout and styling only.

## What it does define

Visual hierarchy, proportions, typography, color, spacing, and density for the Pulse dashboard shell — the sidebar, the center canvas (hero, KPI row, Top Invoices table, Recent Activity), and the right rail (approvals, upcoming, evidence). Use it as the reference for how these regions should look once real data and real functionality are wired in.

## Scope note

**No dashboard visual-parity implementation is part of this work.** Archiving this file is a documentation-only action. Visual parity against this reference remains **deferred** until CSV import and the real-data foundations it depends on (canonical client identity, import persistence) are complete. Do not treat the presence of this file in the repo as an instruction to start matching the dashboard to it.
