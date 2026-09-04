import {
  PROVIDER_TRUTH_DIMENSION as T, CLAIM_SOURCE_OWNER as OWNER,
} from '../../integrations/providerTruthModel.js'
import {
  ACCOUNTING_ADAPTER_WRITE_SUPPORT, finiteAmount, freeze, materialString,
  refetchObligation, requireConnectionIdentity,
} from './accountingAdapterCommon.js'

export const XERO_ACCOUNTING_PROVIDER = 'xero_accounting'

function xeroEventTargets(category) {
  if (category === 'INVOICE') return ['invoice', 'allocations']
  const ownTarget = ({ PAYMENT: 'payment', CREDITNOTE: 'credit_note',
    PREPAYMENT: 'prepayment', OVERPAYMENT: 'overpayment' })[category]
  return ownTarget
    ? [ownTarget, 'invoice', 'allocations', 'customer_unapplied_value']
    : ['invoice', 'payment', 'credit_note', 'prepayment', 'overpayment',
      'allocations', 'customer_unapplied_value']
}

function xeroConnectionIdentity(connection) {
  const identity = requireConnectionIdentity(connection, XERO_ACCOUNTING_PROVIDER)
  if (connection?.connectionId && connection.connectionId === identity.providerAccountId) {
    throw new Error('Xero connectionId cannot be used as providerAccountId tenant identity')
  }
  return identity
}

function invoiceInterpretation(observation) {
  const p = observation.rawPayload
  if (p.Type !== 'ACCREC') throw new Error('only Xero ACCREC invoices can establish accounts-receivable state')
  return freeze({
    truthDimension: T.T1_INVOICE_AR_STATE, sourceOwner: OWNER.LEDGER_SOURCE,
    subject: materialString(p.InvoiceID),
    value: {
      externalInvoiceId: materialString(p.InvoiceID), invoiceNumber: materialString(p.InvoiceNumber),
      contactId: materialString(p.Contact?.ContactID), status: materialString(p.Status),
      total: finiteAmount(p.Total), balance: finiteAmount(p.AmountDue), amountPaid: finiteAmount(p.AmountPaid),
      amountCredited: finiteAmount(p.AmountCredited), currency: materialString(p.CurrencyCode),
      transactionDate: materialString(p.DateString ?? p.Date), dueDate: materialString(p.DueDateString ?? p.DueDate),
      updatedAt: materialString(p.UpdatedDateUTCString ?? p.UpdatedDateUTC),
      paymentRefs: (p.Payments ?? []).map((item) => materialString(item.PaymentID)).filter(Boolean),
      creditNoteRefs: (p.CreditNotes ?? []).map((item) => materialString(item.CreditNoteID)).filter(Boolean),
      prepaymentRefs: (p.Prepayments ?? []).map((item) => materialString(item.PrepaymentID)).filter(Boolean),
      overpaymentRefs: (p.Overpayments ?? []).map((item) => materialString(item.OverpaymentID)).filter(Boolean),
      voided: p.Status === 'VOIDED',
    },
    uncertainty: p.AmountDue == null ? ['AMOUNT_DUE_MISSING_AUTHORITATIVE_DETAIL_REFETCH_REQUIRED'] : [],
  })
}

function allocationInterpretation(observation, kind) {
  const p = observation.rawPayload
  const rawAllocations = (p.Allocations ?? []).map((allocation) => freeze({
    invoiceId: materialString(allocation?.Invoice?.InvoiceID), amount: finiteAmount(allocation?.Amount),
    date: materialString(allocation?.Date),
  })).filter((allocation) => allocation.invoiceId && allocation.amount != null)
  if (kind === 'PAYMENT' && p.Invoice?.InvoiceID && p.Amount != null) {
    rawAllocations.push(freeze({ invoiceId: p.Invoice.InvoiceID, amount: finiteAmount(p.Amount),
      date: materialString(p.Date) }))
  }
  const allocations = [...new Map(rawAllocations.map((allocation) => [
    `${allocation.invoiceId}:${allocation.amount}:${allocation.date ?? ''}`, allocation,
  ])).values()]
  const objectId = materialString(p.PaymentID ?? p.CreditNoteID ?? p.PrepaymentID ?? p.OverpaymentID)
  const remaining = finiteAmount(p.RemainingCredit)
  return freeze({
    truthDimension: T.T4_PAYMENT_CREDIT_ALLOCATION_STATE, sourceOwner: OWNER.LEDGER_SOURCE,
    subject: allocations.length === 1 ? allocations[0].invoiceId : `contact:${materialString(p.Contact?.ContactID) ?? 'unknown'}`,
    value: {
      allocationKind: kind, externalObjectId: objectId, status: materialString(p.Status),
      allocations, amount: finiteAmount(p.Amount ?? p.Total), remainingCredit: remaining,
      currency: materialString(p.CurrencyCode), bankAmount: finiteAmount(p.BankAmount),
      currencyRate: finiteAmount(p.CurrencyRate), accountId: materialString(p.Account?.AccountID),
      providerReconciledField: typeof p.IsReconciled === 'boolean' ? p.IsReconciled : null,
      duewatchT6Established: false, deleted: p.Status === 'DELETED', voided: p.Status === 'VOIDED',
      updatedAt: materialString(p.UpdatedDateUTCString ?? p.UpdatedDateUTC), provesProcessorReceipt: false,
    },
    uncertainty: allocations.length === 0 ? ['NO_INVOICE_ALLOCATION_EVIDENCE'] : [],
  })
}

export const xeroAccountingAdapter = freeze({
  provider: XERO_ACCOUNTING_PROVIDER,
  sourceOwner: OWNER.LEDGER_SOURCE,
  supportedByDuewatchAdapter: freeze({ read: 'YES', write: ACCOUNTING_ADAPTER_WRITE_SUPPORT }),
  providerAccountIdentity: 'XERO_TENANT_OR_ORGANISATION_ID_FROM_CONNECTION_CONTEXT',
  connectionIdLifecycleOwner: 'M2H_CP6',
  createObservationInput({ connection, objectType, payload, observedAt, eventId = null, deliveryId = null }) {
    const identity = xeroConnectionIdentity(connection)
    const idField = ({ Invoice: 'InvoiceID', Payment: 'PaymentID', CreditNote: 'CreditNoteID',
      Prepayment: 'PrepaymentID', Overpayment: 'OverpaymentID' })[objectType]
    const externalObjectId = materialString(payload?.[idField])
    if (!externalObjectId) throw new Error(`Xero ${idField ?? 'object id'} required`)
    return freeze({ ...identity, objectType, externalObjectId,
      rawPayload: JSON.parse(JSON.stringify(payload)),
      providerTimestamp: materialString(payload?.UpdatedDateUTCString ?? payload?.UpdatedDateUTC),
      observedAt, eventId, deliveryId, apiVersion: 'Xero Accounting API OpenAPI 19.0.0' })
  },
  interpretFor(observation) {
    if (observation.provider !== XERO_ACCOUNTING_PROVIDER) throw new Error('wrong provider observation')
    if (observation.objectType === 'Invoice') return invoiceInterpretation(observation)
    if (observation.objectType === 'Payment') return allocationInterpretation(observation, 'PAYMENT')
    if (observation.objectType === 'CreditNote') return allocationInterpretation(observation, 'CREDIT_NOTE')
    if (observation.objectType === 'Prepayment') return allocationInterpretation(observation, 'PREPAYMENT')
    if (observation.objectType === 'Overpayment') return allocationInterpretation(observation, 'OVERPAYMENT')
    throw new Error(`unsupported Xero object type: ${observation.objectType}`)
  },
  parseChangeEvent({ connection, envelope }) {
    let identity
    try {
      identity = xeroConnectionIdentity(connection)
    } catch {
      return freeze({ accepted: false, reason: 'REJECTED_CONNECTION_IDENTITY',
        stateWrittenFromEvent: false })
    }
    const events = Array.isArray(envelope?.events) ? envelope.events : []
    if (events.length === 0) {
      return freeze({ accepted: false, reason: 'REJECTED_XERO_ENVELOPE',
        stateWrittenFromEvent: false })
    }
    if (events.some((event) => {
      const tenantId = materialString(event?.tenantId ?? event?.TenantID)
      return !tenantId || tenantId !== identity.providerAccountId
    })) {
      return freeze({ accepted: false, reason: 'REJECTED_XERO_TENANT', stateWrittenFromEvent: false })
    }
    const normalizedEvents = events.map((event) => {
      const category = materialString(event?.eventCategory ?? event?.EventCategory)?.toUpperCase() ?? 'UNKNOWN'
      const resourceId = materialString(event?.resourceId ?? event?.ResourceID)
      const eventId = materialString(event?.eventId ?? event?.EventID) ?? `${category}:${resourceId ?? 'unknown'}`
      return freeze({ eventId, category, resourceId,
        resourceUrl: materialString(event?.resourceUrl ?? event?.ResourceUrl) })
    })
    const uniqueEvents = [...new Map(normalizedEvents.map((event) => [event.eventId, event])).values()]
      .sort((a, b) => a.eventId.localeCompare(b.eventId))
    const targets = uniqueEvents.flatMap((event) => xeroEventTargets(event.category))
    return freeze({ accepted: true, eventFormat: 'XERO_STANDARD_ENVELOPE', eventEntities: uniqueEvents,
      obligation: refetchObligation({ tenantId: identity.tenantId, provider: identity.provider,
        providerAccountId: identity.providerAccountId,
        eventId: uniqueEvents.map((event) => event.eventId).join('|'),
        targets, reason: 'Xero event is notification evidence only; authoritative resource reread required.' }) })
  },
})
