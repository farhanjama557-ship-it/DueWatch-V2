# M2H — official provider research inventory

**Status: PENDING for every provider. Evidence class E0 (hypothesis) across the board.**

This environment has **no outbound network access** (verified: `developer.intuit.com` and
`stripe.com/docs` both returned HTTP `000`). No official provider documentation was read,
so **no E1/E2/E3 claim is recorded anywhere in this checkpoint** and none may be added
without an actual citation — `recordEvidence` enforces that for E1/E2/E3/E6.

This file is therefore the list of what must be gathered, not a summary of findings.

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
