# M2H — official provider research inventory

**Status: CP2 researched QuickBooks Online Accounting and Xero Accounting from
current official sources on 2026-09-04. Other providers remain E0.**

CP1 correctly recorded that its environment could not read provider sources. CP2 had
read access to current official Intuit Developer pages, Xero Developer pages, Xero's
official OpenAPI 19.0.0, and current official provider release material. CP2 therefore
uses E1/E2/E3 where the cited proposition supports it. No provider sandbox credentials
were available: **E4/E5/E6 remain unclaimed** and fixture replay is not sandbox evidence.

This file remains the cross-checkpoint research ledger: CP2 findings are recorded in
`M2H_CP2_ACCOUNTING_CONNECTORS.md`; all providers not named above still require the
official-source work listed below.

## Required per provider, before its checkpoint

For **QuickBooks Online, Xero, Stripe, Gmail/Google, CRM (GHL), Google Drive, Dropbox**:

1. API reference
2. Machine-readable schema / OpenAPI / SDK types, where published
3. OAuth flow, scope list, and the minimum scopes per operation
4. Webhook / event catalogue and delivery semantics (ordering, retry, signing)
5. Rate limits and backoff expectations
6. Pagination model
7. Change tracking (cursors, `updatedSince`, change data capture)
8. Object identity — stable ids, and what happens on merge/rename
9. Deletion / tombstone semantics
10. Sandbox or test environment availability
11. Token refresh and revocation behaviour
12. Provider account / company identifiers (the `providerAccountId` the kernel requires)

## Open questions CP1 deliberately did not answer

- Does a refund reopen AR? Provider- and policy-specific; `REFUND_ISSUED` refetches
  rather than assuming. Recorded as `STILL_UNKNOWN`.
- Which dimension does a given provider's "payment" object actually speak to? Must be
  established per provider from its own semantics, not by analogy.
- Do any of these providers guarantee webhook ordering? Assumed **not**, which is why the
  replay engine never writes state from an event.

## Discipline

Do not architect from blog posts. Do not mark a claim E2/E3 without an official citation.
An interactive discovery becomes a raw capture plus a permanent fixture, or it did not
happen.
