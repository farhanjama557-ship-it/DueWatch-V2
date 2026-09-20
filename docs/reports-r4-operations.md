# DueWatch Reports — R4 DW / Autopilot Operational Reporting

Status: ACTIVE DEVELOPMENT / NOT MERGED / NOT DEPLOYED

R4 reports operational facts without converting them into unsupported business
outcomes.

## Canonical hierarchy

1. `autopilot_execution_claims` is the durable external-execution receipt.
2. `awaiting_signature` is the founder-approval queue/history.
3. `events` is activity evidence and never grants execution authority.

## Important language rule

An execution claim with `status='sent'` means the provider accepted the send
request through DueWatch's execution boundary. It is not recipient delivery,
open/read proof, payment proof, or evidence that the reminder caused payment.

## R4 reports

- execution claim count
- sent / send_failed / uncertain / in_flight counts
- action-type counts
- provider counts
- approval request counts and known statuses
- activity event counts by type
- malformed/duplicate data-quality counts

## Explicitly unavailable

- time saved
- recovered cash attributed to Autopilot
- Autopilot ROI
- recipient delivery rate

Those stay unavailable until a separate proof model can establish them.
