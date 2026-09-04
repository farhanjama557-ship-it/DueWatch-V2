# M2H-CP2 — QuickBooks Online and Xero accounting connectors

Research captured 2026-09-04. This checkpoint is a pure read/interpretation layer over
the frozen CP1 Provider Lab and trust kernel. It contains no OAuth control plane,
network client, persistence, schema, migration, provider SDK, webhook receiver, write
operation, execution path, or UI.

## Official source inventory

### QuickBooks Online

- [Accounting API overview](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api)
- [Invoice API Explorer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/invoice)
- [Payment API Explorer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/payment)
- [CreditMemo API Explorer](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/creditmemo)
- [Webhooks](https://developer.intuit.com/app/developer/qbo/docs/develop/webhooks)
- [Mandatory CloudEvents payload migration](https://blogs.intuit.com/2025/11/12/upcoming-change-to-webhooks-payload-structure)
- [Official PHP SDK CloudEvents parser](https://github.com/intuit/QuickBooks-V3-PHP-SDK/blob/master/src/WebhooksService/WebhooksService.php)
- [Change data capture](https://developer.intuit.com/app/developer/qbo/docs/learn/explore-the-quickbooks-online-api/change-data-capture)
- [Current 2026 Accounting API changes](https://medium.com/intuitdev/upcoming-changes-to-accounting-apis-that-may-impact-your-application-023386ca2c52)

The API Explorer pages are JavaScript-rendered in this research environment. Their
current URLs were inspected and recorded; schema propositions are not upgraded beyond
the evidence that could actually be read. Current Intuit material identifies `realmId`
as company identity, query pagination as `STARTPOSITION`/`MAXRESULTS`, and CDC as a
changed-since recovery mechanism with a bounded history. Intuit's current SDK and
official migration notice establish that the mandatory 2026 webhook body is an array of
CloudEvents carrying `intuitaccountid` and `intuitentityid`; the adapter parses that
format, while retaining legacy envelopes only for explicit replay compatibility. CP2
therefore treats webhook and CDC delivery as invalidation—not truth—and makes
completeness explicit.

### Xero

- [Official Accounting OpenAPI 19.0.0](https://raw.githubusercontent.com/XeroAPI/Xero-OpenAPI/master/xero_accounting.yaml)
- [Invoices](https://developer.xero.com/documentation/api/accounting/invoices)
- [Payments](https://developer.xero.com/documentation/api/accounting/payments)
- [Credit Notes](https://developer.xero.com/documentation/api/accounting/creditnotes)
- [Prepayments](https://developer.xero.com/documentation/api/accounting/prepayments)
- [Overpayments](https://developer.xero.com/documentation/api/accounting/overpayments)
- [HTTP requests, modified-since and paging](https://developer.xero.com/documentation/api/accounting/requests-and-responses)
- [Tenants/connections](https://developer.xero.com/documentation/guides/oauth2/tenants)
- [OAuth request tenant header](https://developer.xero.com/documentation/guides/oauth2/auth-flow)
- [Webhook subscriptions](https://developer.xero.com/documentation/guides/webhooks/subscriptions)
- [Prepayment webhooks](https://developer.xero.com/documentation/guides/webhooks/prepayments)
- [Overpayment webhooks](https://developer.xero.com/documentation/guides/webhooks/overpayments)
- [Credit Note webhooks](https://developer.xero.com/documentation/guides/webhooks/credit-notes)

OpenAPI 19.0.0 explicitly contains `Invoice`, `Payment`, `CreditNote`, `Prepayment`, and
`Overpayment`; their stable IDs and update timestamps; invoice summary collections;
allocation arrays; `RemainingCredit`; `Amount`, `BankAmount`, `CurrencyRate`; Payment
statuses `AUTHORISED`/`DELETED`; and `IsReconciled`. It also places
`If-Modified-Since` on the relevant collection reads and requires the tenant header.

## Identity decisions

QuickBooks `providerAccountId` is the expected **realm/company ID from connection
context**. A payload entity ID or webhook object ID never chooses it. Same object ID in
two realms is two objects.

Xero `providerAccountId` is the expected **Xero tenant/organisation ID** used as
`xero-tenant-id`, from connection context. An OAuth connections-endpoint connection ID
is lifecycle metadata, not a substitute organisation boundary. CP6 will durably map a
DueWatch connection ID to provider and expected provider account. Same object ID under
two Xero organisations is two objects.

Neither adapter infers DueWatch tenant identity from a provider payload. CP2 creates no
cross-provider Customer/Contact or Invoice identity; CP7 owns reconciliation.

## Observation and interpretation examples

The immutable observation retains provider-native shape. A QBO Invoice observation can
retain `Balance`, `TotalAmt`, `CurrencyRef`, `CustomerRef`, `SyncToken`, `MetaData`, and
links. Its replaceable interpretation states T1, subject invoice ID, balance, currency,
dates, provider status and uncertainty.

A Xero Payment observation retains `PaymentID`, `Invoice`, `Amount`, `BankAmount`,
`CurrencyRate`, `Account`, `IsReconciled`, status and update identity. Its interpretation
states T4 allocation, explicitly says `provesProcessorReceipt: false`, and preserves
`IsReconciled` only as provider context.

## Evidence matrix

| Proposition | QBO | Xero | CP2 status |
|---|---|---|---|
| Outstanding invoice balance represents provider AR state | E2 official API Explorer | E1 official OpenAPI + E2 docs; E3 composable | T1 adapter mapping |
| An explicit invoice allocation represents allocated ledger value | E2 API Explorer | E1 OpenAPI + E2 docs; E3 composable | T4 adapter mapping |
| An accounting object called Payment proves processor receipt | no supporting evidence | no supporting evidence | rejected; never T3 |
| Remaining/unapplied credit must be preserved | E2 fields/docs | E1 OpenAPI + E2 docs | T4 context, not cash |
| Two providers support balance-as-AR proposition | support-bearing evidence from both | support-bearing evidence from both | E7 composable, not G5 |
| Fixture behavior was observed in provider sandbox | none | none | E4/E5/E6 unclaimed |

Evidence classes are kinds, not a score. E3 is composed only for the same provider and
same proposition; E7 only from support-bearing records for a provider-neutral
proposition. CP2 cannot produce a G5 locked canonical rule.

## Truth mappings

| Provider object | Dimension | Meaning |
|---|---|---|
| QBO Invoice | T1 | current provider AR balance/state |
| QBO Payment invoice link | T4 | accounting allocation; unapplied value remains explicit |
| QBO CreditMemo invoice link | T4 | credit allocation; issuance is not cash |
| Xero ACCREC Invoice | T1 | AmountDue/current provider AR state |
| Xero Payment Invoice relationship | T4 | accounting allocation, not processor receipt |
| Xero CreditNote Allocation | T4 | credit allocation; remaining credit retained |
| Xero Prepayment Allocation | T4 | prepayment allocation; remaining credit retained |
| Xero Overpayment Allocation | T4 | overpayment allocation; remaining credit retained |

T2, T3 and T5 remain absent. T6 remains **UNKNOWN**: Xero documents what
`IsReconciled` says about a Payment, but that field alone does not establish DueWatch's
full bank/ledger reconciliation proposition and the observation is owned as a ledger
allocation claim. QBO has no CP2 T6 mapping. Hostile tests lock those distinctions.

## Multicurrency

QBO retains transaction `CurrencyRef` and provider exchange-rate context without
inventing a converted balance. Xero retains transaction `Amount`, bank-account
`BankAmount`, `CurrencyRate`, and currency separately. CP2 performs no conversion and
never compares unlike currency amounts as though they shared a unit.

## Change detection and paging

Provider events are scoped before they can create an invalidation/refetch obligation.
QBO events must match the connection realm; Xero events must match the connection Xero
tenant. Event data writes no financial truth. Invoice/payment/credit notifications
require authoritative resource rereads. Exact wire-body signature verification,
delivery durability, retry queues, connection health and persistent obligations remain
CP6.

The pure sync state requires full tenant/provider/account identity on every page,
deduplicates by account-scoped object identity, keeps the newest provider update, and
requires an explicit terminal page. A failed page makes the sync incomplete; a retry or
modified-since boundary duplicate is idempotent. No failed/unavailable read becomes an
empty source. QBO query/CDC truncation and Xero page/If-Modified-Since retrieval must be
driven by CP6 until a complete authoritative reread is established.

## Capability and deferred production requirements

Both adapters declare read support YES and DueWatch write support **NO**. Provider APIs
may technically offer writes and OAuth scopes may permit them; neither fact grants G5
authority or creates an execution path.

CP6 owns durable OAuth connection records, tokens, scope/revocation lifecycle,
signatures over exact HTTP bytes, endpoints, retries, health, persistent freshness,
invalidation/refetch obligations and trusted rehydration. CP2 stores no credentials and
makes no provider network calls.

## Known unknowns

- No live sandbox calls were made; sandbox quirks and demo-organisation behavior remain
  hypotheses until captured and reproduced.
- QBO webhook/CDC completeness and delete/void edge behavior require a live sandbox
  capture before E4+.
- Xero list-vs-detail omission behavior is treated conservatively: missing AmountDue
  produces uncertainty/refetch, never a zero.
- Xero `IsReconciled` does not map to T6 in CP2.
- Credit/payment reversals trigger reread; CP2 does not infer the resulting invoice
  balance from an event.

## Permanent ugly scenarios

Tests record complete ugly-scenario entries for QBO unapplied payment, Xero
`IsReconciled`, and multicurrency Amount/BankAmount divergence. Their invariant is the
same: preserve the provider observation, interpret only its evidenced dimension,
require authoritative reread after change, and never grant authority.
