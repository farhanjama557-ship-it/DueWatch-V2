# M2H — Provider Lab

Deterministic, local, no credentials. CP1 builds the harness so CP2–CP5 become
*adapter + fixtures + the shared corpus*, not seven bespoke integrations.

    R0 knowledge → canonical scenario corpus → provider adapter → raw fixture capture
      → webhook replay → deterministic contract tests → cross-provider differential
      → generated adversarial companies → failure/recovery → interactive E2E → regression

CP1 implements everything above the "interactive E2E" line, locally.

The current lab contains nine suites and 217 deterministic tests. The decision-boundary
suite includes a 21,870-case cross-product over balance, freshness, context and policy;
`ELIGIBLE` is reachable only in the single explicitly complete safe subset.

## Canonical scenario corpus (S001–S020)

Provider-neutral by construction — a test asserts no provider field name appears in the
corpus, because that is what lets CP2 attach QuickBooks fixtures and CP3 attach Stripe
fixtures to the *same* twenty scenarios.

Each scenario can specify tenant, provider, provider account, raw observations,
timestamps, truth dimensions, source ownership, entity references, expected normalized
claims, freshness, invalidation, refetch set, conflict state, expected collection
eligibility, and expected authority effect.

**Every scenario expects `expectAuthorityEffect: 'NONE'`.** Provider state never grants
G5 authority, asserted once per scenario so a future author has to break it consciously.

## Webhook replay

The property is **not** "process every event as truth". It is convergence:

    event → invalidation → authoritative refetch → current interpretation

Covered: normal order, duplicate delivery, duplicate semantic event under a new delivery
id, out-of-order, delayed, retry after processor failure, dropped event with authoritative
refetch, an old event arriving after newer state, and wrong tenant / wrong provider
account. Events never write state (`stateWrittenFromEvent: false`); the refetch does.

## Adversarial company generator

Seed **829144**, carried forward from prior adversarial work. Deterministic: a failure is
reproducible from its seed alone. Generates same-name client collisions, disputes,
credits, stale ledgers, unavailable sources, and mixed event streams including
unrecognised mutation types.

## Differential harness

Runs one provider-neutral scenario through several adapters and compares DueWatch's
**interpretation**, not the provider payloads. The mock adapters are deliberately
dissimilar — dollars vs minor units, `Balance` vs `amount_received`, different status
vocabularies. Providers are allowed to look nothing alike; what must agree is the truth
dimension, the owner, and the meaning. A test proves the harness *detects* a mismatch
rather than smoothing it, or it would be useless in CP2+.

## Raw fixture policy

Every captured fixture carries provider, object/event type, account anonymization
strategy, capture timestamp, API version, fixture version, evidence class, sanitization
statement and expected interpretation. `providerFixture()` **throws** if the payload
contains `access_token`, `refresh_token`, `client_secret`, `signing_secret` or
`authorization`.

## Ugly-scenario format

The permanent home for a provider surprise: id, initial state, trigger, observed
behaviour, dimensions affected, the **dangerous** interpretation, the correct one,
required invalidation, collection eligibility, evidence, and the invariant tested. Every
field is required. Nobody should rediscover the same provider behaviour twice.

## Automation split

Target 80–90% automated. Reserved for interactive/browser work: OAuth consent UI, partial
permission denial, disconnect from the provider's own UI, provider-specific UI behaviour,
ambiguous docs vs actual behaviour, and founder onboarding usability. Each interactive
discovery must become a raw capture + documented observation + evidence class + permanent
fixture before it counts.
