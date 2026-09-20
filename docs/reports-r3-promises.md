# DueWatch Reports — R3 Promise-to-Pay Reporting

Status: ACTIVE DEVELOPMENT / NOT MERGED / NOT DEPLOYED

R3 is intentionally bounded by the Promise-to-Pay backend that actually exists
on `qwen/verify-promise-to-pay`.

The verified PTP foundation currently proves only:

`proposed -> confirmed`

and stores one governing confirmed promise per invoice. It does not yet persist
Fulfilled, Broken, Cancelled, Rejected, or Superseded states.

## What R3 can report truthfully now

- proposals needing confirmation
- future confirmed promises
- due-soon confirmed promises
- due-today confirmed promises
- confirmed promises whose date has passed and remain unresolved
- promised amount/count, always separated by currency
- malformed/unsupported promise data counts

## What R3 deliberately does not claim

- kept-promise rate
- broken-promise rate
- fulfilled amount
- payment-to-promise attribution
- promise reliability score

A past-due confirmed promise is labeled `past_due_unresolved`, not `broken`.
That distinction is load-bearing until the PTP lifecycle adds proven terminal
transitions/evidence.
