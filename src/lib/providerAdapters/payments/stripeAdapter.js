/**
 * M2H-CP3 — Stripe read/interpretation adapter.
 *
 * This is a Provider Lab adapter, not an OAuth client or webhook receiver. It
 * creates CP1 observation inputs and replaceable interpretation descriptors;
 * CP1 alone constructs observations, resolves freshness and admits claims.
 */

import {
  PROVIDER_TRUTH_DIMENSION as T, CLAIM_SOURCE_OWNER as OWNER,
} from '../../integrations/providerTruthModel.js'
import {
  freeze, materialString, finiteAmount, requireConnectionIdentity,
} from '../accounting/accountingAdapterCommon.js'

export const STRIPE_PROVIDER = 'stripe'
export const STRIPE_ADAPTER_WRITE_SUPPORT = 'NO'

const OBJECT_ID_FIELD = Object.freeze({
  Invoice: 'id', PaymentIntent: 'id', Charge: 'id', InvoicePayment: 'id',
  PaymentRecord: 'id', PaymentAttemptRecord: 'id', CreditNote: 'id',
  CustomerBalanceTransaction: 'id', CashBalanceTransaction: 'id',
  Refund: 'id', Dispute: 'id', BalanceTransaction: 'id', Payout: 'id',
  Balance: null,
})

function modeName(livemode) {
  return livemode ? 'live' : 'test'
}

function stripeConnectionIdentity(connection) {
  const identity = requireConnectionIdentity(connection, STRIPE_PROVIDER)
  if (typeof connection?.livemode !== 'boolean') throw new Error('Stripe connection livemode required')
  return freeze({ tenantId: identity.tenantId, provider: identity.provider,
    stripeAccountId: identity.providerAccountId,
    // CP1's immutable identity tuple has no separate mode member. Binding mode
    // into the provider-account scope lets frozen CP1 reject a test claim when
    // a live connection is expected instead of trusting an ignored extra key.
    providerAccountId: `${identity.providerAccountId}:${modeName(connection.livemode)}`,
    livemode: connection.livemode,
    eventScope: connection.eventScope === 'CONNECTED_ACCOUNT'
      ? 'CONNECTED_ACCOUNT' : 'ACCOUNT' })
}

export function stripeAdmissionIdentity(connection) {
  const identity = stripeConnectionIdentity(connection)
  return freeze({ tenantId: identity.tenantId, provider: identity.provider,
    providerAccountId: identity.providerAccountId })
}

function nativeId(value) {
  return typeof value === 'string' ? value : materialString(value?.id)
}

function scopedId(identity, id) {
  return `stripe:${modeName(identity.livemode)}:${id}`
}

function timestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value * 1000)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
  }
  return materialString(value)
}

function amountObject(value) {
  return freeze({ value: finiteAmount(value?.value), currency: materialString(value?.currency) })
}

function invoiceInterpretation(observation) {
  const p = observation.rawPayload
  const payments = p.payments && typeof p.payments === 'object' ? p.payments : null
  return freeze({
    truthDimension: T.T1_INVOICE_AR_STATE,
    sourceOwner: OWNER.INVOICE_ORIGIN_SOURCE,
    subject: scopedId({ livemode: p.__duewatchLivemode }, p.id),
    value: {
      externalInvoiceId: materialString(p.id), invoiceNumber: materialString(p.number),
      customerId: nativeId(p.customer), status: materialString(p.status),
      amountDue: finiteAmount(p.amount_due), amountPaid: finiteAmount(p.amount_paid),
      amountPaidOffStripe: finiteAmount(p.amount_paid_off_stripe),
      amountRemaining: finiteAmount(p.amount_remaining), amountOverpaid: finiteAmount(p.amount_overpaid),
      total: finiteAmount(p.total), currency: materialString(p.currency),
      dueDate: timestamp(p.due_date), createdAt: timestamp(p.created),
      statusTransitions: p.status_transitions ?? null, collectionMethod: materialString(p.collection_method),
      prePaymentCreditNotesAmount: finiteAmount(p.pre_payment_credit_notes_amount),
      postPaymentCreditNotesAmount: finiteAmount(p.post_payment_credit_notes_amount),
      paymentRefs: (payments?.data ?? []).map((item) => materialString(item?.id)).filter(Boolean),
      paymentListComplete: payments ? payments.has_more === false : null,
      livemode: p.__duewatchLivemode,
      provesProcessorReceipt: false,
    },
    uncertainty: [
      ...(p.amount_remaining == null ? ['AMOUNT_REMAINING_MISSING'] : []),
      ...(payments?.has_more === true ? ['INVOICE_PAYMENT_LIST_INCOMPLETE_AUTHORITATIVE_PAGE_REQUIRED'] : []),
      ...(finiteAmount(p.amount_paid_off_stripe) > 0
        ? ['OFF_STRIPE_AMOUNT_IS_INVOICE_STATE_NOT_STRIPE_PROCESSOR_RECEIPT'] : []),
    ],
  })
}

function paymentIntentInterpretation(observation) {
  const p = observation.rawPayload
  const succeeded = p.status === 'succeeded' && finiteAmount(p.amount_received) > 0 &&
    materialString(p.currency) != null
  return freeze({
    truthDimension: succeeded ? T.T3_PAYMENT_RECEIPT_STATE : T.T2_PAYMENT_ATTEMPT_STATE,
    sourceOwner: OWNER.PAYMENT_PROCESSOR,
    subject: scopedId({ livemode: p.__duewatchLivemode }, p.id),
    value: {
      externalPaymentIntentId: materialString(p.id), status: materialString(p.status),
      amount: finiteAmount(p.amount), amountReceived: finiteAmount(p.amount_received),
      amountCapturable: finiteAmount(p.amount_capturable), currency: materialString(p.currency),
      customerId: nativeId(p.customer), invoiceId: nativeId(p.invoice),
      latestChargeId: nativeId(p.latest_charge), cancellationReason: materialString(p.cancellation_reason),
      processorReceiptEstablished: succeeded, livemode: p.__duewatchLivemode,
      createdAt: timestamp(p.created),
    },
    uncertainty: succeeded ? [] : ['PAYMENT_INTENT_NOT_A_SUCCEEDED_RECEIPT'],
  })
}

function chargeInterpretation(observation) {
  const p = observation.rawPayload
  // Stripe documents paid=true as also covering successful authorization for
  // later capture. Requiring capture avoids upgrading authorization to receipt.
  const received = p.paid === true && p.captured === true &&
    finiteAmount(p.amount_captured) > 0 && materialString(p.currency) != null &&
    !materialString(p.failure_code)
  const paymentIntentId = nativeId(p.payment_intent)
  return freeze({
    truthDimension: received ? T.T3_PAYMENT_RECEIPT_STATE : T.T2_PAYMENT_ATTEMPT_STATE,
    sourceOwner: OWNER.PAYMENT_PROCESSOR,
    // A Charge belonging to a PaymentIntent is the same processor receipt,
    // not a second payment. Shared subject identity prevents double counting.
    subject: scopedId({ livemode: p.__duewatchLivemode }, paymentIntentId ?? p.id),
    value: {
      receiptIdentity: paymentIntentId ? `payment_intent:${paymentIntentId}` : `charge:${p.id}`,
      externalChargeId: materialString(p.id), paymentIntentId,
      paid: p.paid === true, captured: p.captured === true,
      amount: finiteAmount(p.amount), amountCaptured: finiteAmount(p.amount_captured),
      amountRefunded: finiteAmount(p.amount_refunded), refunded: p.refunded === true,
      disputed: p.disputed === true, currency: materialString(p.currency),
      balanceTransactionId: nativeId(p.balance_transaction),
      processorReceiptEstablished: received, livemode: p.__duewatchLivemode,
      createdAt: timestamp(p.created),
    },
    uncertainty: received ? [] : ['CHARGE_NOT_CAPTURED_RECEIPT'],
  })
}

function invoicePaymentInterpretation(observation) {
  const p = observation.rawPayload
  const invoiceId = nativeId(p.invoice)
  const paymentType = materialString(p.payment?.type)
  return freeze({
    truthDimension: T.T4_PAYMENT_CREDIT_ALLOCATION_STATE,
    sourceOwner: OWNER.LEDGER_SOURCE,
    subject: invoiceId ? scopedId({ livemode: p.__duewatchLivemode }, invoiceId)
      : scopedId({ livemode: p.__duewatchLivemode }, p.id),
    value: {
      allocationKind: 'STRIPE_INVOICE_PAYMENT', externalInvoicePaymentId: materialString(p.id),
      invoiceId, status: materialString(p.status), amountRequested: finiteAmount(p.amount_requested),
      amountPaid: finiteAmount(p.amount_paid), currency: materialString(p.currency),
      isDefault: p.is_default === true, paymentType,
      paymentIntentId: nativeId(p.payment?.payment_intent),
      chargeId: nativeId(p.payment?.charge),
      paymentRecordId: nativeId(p.payment?.payment_record),
      paidAt: timestamp(p.status_transitions?.paid_at), livemode: p.__duewatchLivemode,
      provesProcessorReceipt: false,
    },
    uncertainty: invoiceId ? [] : ['INVOICE_RELATIONSHIP_MISSING'],
  })
}

function paymentRecordInterpretation(observation, attempt = false) {
  const p = observation.rawPayload
  const stripeReported = p.reported_by === 'stripe' && p.processor_details?.type === 'stripe'
  const guaranteed = finiteAmount(p.amount_guaranteed?.value) ?? 0
  const receipt = stripeReported && guaranteed > 0 &&
    materialString(p.amount_guaranteed?.currency) != null
  return freeze({
    truthDimension: receipt ? T.T3_PAYMENT_RECEIPT_STATE : T.T2_PAYMENT_ATTEMPT_STATE,
    sourceOwner: OWNER.PAYMENT_PROCESSOR,
    subject: scopedId({ livemode: p.__duewatchLivemode }, attempt ? (nativeId(p.payment_record) ?? p.id) : p.id),
    value: {
      recordKind: attempt ? 'PAYMENT_ATTEMPT_RECORD' : 'PAYMENT_RECORD',
      externalObjectId: materialString(p.id), paymentRecordId: nativeId(p.payment_record),
      reportedBy: materialString(p.reported_by), processorType: materialString(p.processor_details?.type),
      amountRequested: amountObject(p.amount_requested ?? p.amount),
      amountAuthorized: amountObject(p.amount_authorized), amountGuaranteed: amountObject(p.amount_guaranteed),
      amountFailed: amountObject(p.amount_failed), amountCanceled: amountObject(p.amount_canceled),
      amountRefunded: amountObject(p.amount_refunded),
      latestPaymentAttemptRecordId: nativeId(p.latest_payment_attempt_record),
      stripeProcessorReceiptEstablished: receipt, livemode: p.__duewatchLivemode,
      createdAt: timestamp(p.created),
    },
    uncertainty: receipt ? [] : ['PAYMENT_RECORD_DOES_NOT_PROVE_STRIPE_PROCESSOR_RECEIPT'],
  })
}

function creditAllocationInterpretation(observation, kind) {
  const p = observation.rawPayload
  const invoiceId = nativeId(p.invoice)
  const amount = finiteAmount(p.amount ?? p.amount_remaining ?? p.net_amount)
  return freeze({
    truthDimension: T.T4_PAYMENT_CREDIT_ALLOCATION_STATE,
    sourceOwner: OWNER.LEDGER_SOURCE,
    subject: scopedId({ livemode: p.__duewatchLivemode }, invoiceId ?? nativeId(p.customer) ?? p.id),
    value: {
      allocationKind: kind, externalObjectId: materialString(p.id), invoiceId,
      customerId: nativeId(p.customer), amount, currency: materialString(p.currency),
      creditBalance: finiteAmount(p.ending_balance), type: materialString(p.type),
      creditNoteId: nativeId(p.credit_note), appliedToInvoice: Boolean(invoiceId),
      livemode: p.__duewatchLivemode, createdAt: timestamp(p.created),
      provesProcessorReceipt: false,
    },
    uncertainty: invoiceId ? [] : ['NO_INVOICE_ALLOCATION_EVIDENCE'],
  })
}

function refundOrDisputeInterpretation(observation, kind) {
  const p = observation.rawPayload
  const paymentIntentId = nativeId(p.payment_intent)
  const chargeId = nativeId(p.charge)
  return freeze({
    truthDimension: T.T3_PAYMENT_RECEIPT_STATE,
    sourceOwner: OWNER.PAYMENT_PROCESSOR,
    subject: scopedId({ livemode: p.__duewatchLivemode }, paymentIntentId ?? chargeId ?? p.id),
    value: {
      processorEventKind: kind, externalObjectId: materialString(p.id), paymentIntentId, chargeId,
      amount: finiteAmount(p.amount), currency: materialString(p.currency), status: materialString(p.status),
      balanceTransactionId: nativeId(p.balance_transaction),
      balanceTransactionIds: (p.balance_transactions ?? []).map(nativeId).filter(Boolean),
      receiptReversalOrContest: true, livemode: p.__duewatchLivemode,
      createdAt: timestamp(p.created),
      reopensInvoiceAr: false,
    },
    uncertainty: ['AUTHORITATIVE_INVOICE_AND_PROCESSOR_REFETCH_REQUIRED'],
  })
}

function settlementInterpretation(observation, kind) {
  const p = observation.rawPayload
  const value = kind === 'BALANCE'
    ? { available: p.available ?? [], pending: p.pending ?? [], instantAvailable: p.instant_available ?? [] }
    : {
      amount: finiteAmount(p.amount), fee: finiteAmount(p.fee), net: finiteAmount(p.net),
      currency: materialString(p.currency), status: materialString(p.status),
      availableOn: timestamp(p.available_on), exchangeRate: finiteAmount(p.exchange_rate),
      sourceId: nativeId(p.source), balanceTransactionId: nativeId(p.balance_transaction),
      failureBalanceTransactionId: nativeId(p.failure_balance_transaction),
      arrivalDate: timestamp(p.arrival_date), reconciliationStatus: materialString(p.reconciliation_status),
    }
  return freeze({
    truthDimension: T.T5_PROCESSOR_FUNDS_SETTLEMENT_STATE,
    sourceOwner: OWNER.PAYMENT_PROCESSOR,
    subject: scopedId({ livemode: p.__duewatchLivemode }, p.id ?? `balance:${modeName(p.__duewatchLivemode)}`),
    value: { settlementKind: kind, externalObjectId: materialString(p.id), ...value,
      livemode: p.__duewatchLivemode, createdAt: timestamp(p.created), establishesBankLedgerReconciliation: false },
    uncertainty: kind === 'PAYOUT' && p.status === 'paid'
      ? ['PAYOUT_PAID_CAN_LATER_FAIL_BANK_LEDGER_RECONCILIATION_NOT_ESTABLISHED'] : [],
  })
}

function eventTargets(type) {
  if (/^invoice\./.test(type)) return ['invoice', 'invoice_payment', 'payment_intent', 'credit_note', 'customer_balance']
  if (/^invoice_payment\./.test(type)) return ['invoice_payment', 'invoice', 'payment_intent', 'payment_record']
  if (/^(refund\.|charge\.refund)/.test(type)) return ['refund', 'charge', 'payment_intent', 'invoice_payment', 'invoice', 'customer_balance', 'balance_transaction', 'balance']
  if (/^(dispute\.|charge\.dispute)/.test(type)) return ['dispute', 'refund', 'charge', 'payment_intent', 'invoice_payment', 'invoice', 'customer_balance', 'balance_transaction', 'balance']
  if (/^(payment_intent|charge)\./.test(type)) return ['payment_intent', 'charge', 'invoice_payment', 'invoice', 'balance_transaction']
  if (/^(payment_record|payment_attempt_record)\./.test(type)) return ['payment_record', 'payment_attempt_record', 'invoice_payment', 'invoice']
  if (/^(credit_note|customer\.balance|customer_cash_balance_transaction)\./.test(type)) return ['credit_note', 'customer_balance', 'invoice_payment', 'invoice']
  if (/^(balance|payout)\./.test(type)) return ['balance', 'balance_transaction', 'payout']
  return ['invoice', 'invoice_payment', 'payment_intent', 'charge', 'payment_record',
    'credit_note', 'customer_balance', 'refund', 'dispute', 'balance_transaction', 'payout', 'balance']
}

function stripeRefetchObligation(identity, envelope, targets) {
  return freeze({
    kind: 'M2H_CP3_STRIPE_REFETCH_OBLIGATION_V0',
    tenantId: identity.tenantId, provider: identity.provider,
    providerAccountId: identity.providerAccountId, livemode: identity.livemode,
    eventId: materialString(envelope.id), eventType: materialString(envelope.type),
    eventApiVersion: materialString(envelope.api_version),
    targets: [...new Set(targets)].sort(), stateWrittenFromEvent: false,
    reason: 'Stripe event is invalidation evidence only; authoritative scoped reread required.',
    persistentLifecycleOwner: 'M2H_CP6', signatureVerifiedByAdapter: false,
  })
}

export function createStripeSyncState(expectedConnection) {
  const expected = stripeConnectionIdentity(expectedConnection)
  const objects = new Map()
  let failed = false
  let terminalPageSeen = false
  return {
    ingestPage({ connection, items = [], hasMore, failed: pageFailed = false } = {}) {
      let supplied
      try { supplied = stripeConnectionIdentity(connection) } catch {
        return freeze({ accepted: false, reason: 'REJECTED_CONNECTION_IDENTITY', syncComplete: false,
          itemCount: objects.size })
      }
      for (const field of ['tenantId', 'provider', 'providerAccountId', 'livemode']) {
        if (supplied[field] !== expected[field]) {
          return freeze({ accepted: false, reason: `REJECTED_${field.toUpperCase()}`,
            syncComplete: false, itemCount: objects.size })
        }
      }
      if (pageFailed) {
        failed = true
        return freeze({ accepted: false, reason: 'PAGE_FAILED', syncComplete: false,
          itemCount: objects.size })
      }
      if (typeof hasMore !== 'boolean') failed = true
      for (const item of items) {
        const objectType = materialString(item?.objectType)
        const externalObjectId = materialString(item?.externalObjectId)
        const versionAt = Date.parse(item?.versionAt ?? '')
        if (!objectType || !externalObjectId || !Number.isFinite(versionAt) ||
            (typeof item.livemode === 'boolean' && item.livemode !== expected.livemode)) {
          failed = true
          continue
        }
        const key = `${expected.provider}:${expected.providerAccountId}:${modeName(expected.livemode)}:${objectType}:${externalObjectId}`
        const prior = objects.get(key)
        if (!prior || versionAt > prior.versionAt) objects.set(key, { ...structuredClone(item), versionAt })
      }
      terminalPageSeen ||= hasMore === false
      return freeze({ accepted: true, reason: null, syncComplete: terminalPageSeen && !failed,
        itemCount: objects.size })
    },
    get snapshot() {
      return freeze({ syncComplete: terminalPageSeen && !failed, sourceUnavailable: failed,
        items: [...objects.values()].map(({ versionAt, ...item }) => item) })
    },
  }
}

export const stripeAdapter = freeze({
  provider: STRIPE_PROVIDER,
  supportedByDuewatchAdapter: freeze({ read: 'YES', write: STRIPE_ADAPTER_WRITE_SUPPORT }),
  providerAccountIdentity: 'STRIPE_ACCOUNT_ID_PLUS_TEST_OR_LIVE_MODE_FROM_CONNECTION_CONTEXT',
  createObservationInput({ connection, objectType, payload, observedAt, eventId = null, deliveryId = null }) {
    const identity = stripeConnectionIdentity(connection)
    if (!Object.hasOwn(OBJECT_ID_FIELD, objectType)) throw new Error(`unsupported Stripe object type: ${objectType}`)
    if (typeof payload?.livemode === 'boolean' && payload.livemode !== identity.livemode) {
      throw new Error('Stripe object livemode does not match connection')
    }
    const id = objectType === 'Balance'
      ? `balance:${modeName(identity.livemode)}` : materialString(payload?.[OBJECT_ID_FIELD[objectType]])
    if (!id) throw new Error(`Stripe ${objectType} id required`)
    const rawPayload = { ...structuredClone(payload), __duewatchLivemode: identity.livemode }
    return freeze({ tenantId: identity.tenantId, provider: identity.provider,
      providerAccountId: identity.providerAccountId, objectType,
      externalObjectId: scopedId(identity, id), rawPayload,
      providerTimestamp: timestamp(payload?.created), observedAt, eventId, deliveryId,
      apiVersion: 'Stripe API 2026-08-26.preview research snapshot' })
  },
  interpretFor(observation) {
    if (observation.provider !== STRIPE_PROVIDER) throw new Error('wrong provider observation')
    if (observation.objectType === 'Invoice') return invoiceInterpretation(observation)
    if (observation.objectType === 'PaymentIntent') return paymentIntentInterpretation(observation)
    if (observation.objectType === 'Charge') return chargeInterpretation(observation)
    if (observation.objectType === 'InvoicePayment') return invoicePaymentInterpretation(observation)
    if (observation.objectType === 'PaymentRecord') return paymentRecordInterpretation(observation)
    if (observation.objectType === 'PaymentAttemptRecord') return paymentRecordInterpretation(observation, true)
    if (observation.objectType === 'CreditNote') return creditAllocationInterpretation(observation, 'CREDIT_NOTE')
    if (observation.objectType === 'CustomerBalanceTransaction') return creditAllocationInterpretation(observation, 'CUSTOMER_BALANCE_TRANSACTION')
    if (observation.objectType === 'CashBalanceTransaction') return creditAllocationInterpretation(observation, 'CASH_BALANCE_TRANSACTION')
    if (observation.objectType === 'Refund') return refundOrDisputeInterpretation(observation, 'REFUND')
    if (observation.objectType === 'Dispute') return refundOrDisputeInterpretation(observation, 'DISPUTE')
    if (observation.objectType === 'BalanceTransaction') return settlementInterpretation(observation, 'BALANCE_TRANSACTION')
    if (observation.objectType === 'Payout') return settlementInterpretation(observation, 'PAYOUT')
    if (observation.objectType === 'Balance') return settlementInterpretation(observation, 'BALANCE')
    throw new Error(`unsupported Stripe object type: ${observation.objectType}`)
  },
  parseChangeEvent({ connection, envelope }) {
    let identity
    try { identity = stripeConnectionIdentity(connection) } catch {
      return freeze({ accepted: false, reason: 'REJECTED_CONNECTION_IDENTITY', stateWrittenFromEvent: false })
    }
    if (!materialString(envelope?.id) || !materialString(envelope?.type) ||
        typeof envelope?.livemode !== 'boolean') {
      return freeze({ accepted: false, reason: 'REJECTED_STRIPE_EVENT_ENVELOPE', stateWrittenFromEvent: false })
    }
    if (envelope.livemode !== identity.livemode) {
      return freeze({ accepted: false, reason: 'REJECTED_STRIPE_MODE', stateWrittenFromEvent: false })
    }
    const account = materialString(envelope.account)
    if ((account && account !== identity.stripeAccountId) ||
        (identity.eventScope === 'CONNECTED_ACCOUNT' && !account)) {
      return freeze({ accepted: false, reason: 'REJECTED_STRIPE_ACCOUNT', stateWrittenFromEvent: false })
    }
    const type = envelope.type.trim()
    return freeze({ accepted: true, eventFormat: 'STRIPE_EVENT_SNAPSHOT',
      eventEntity: { id: envelope.id, type, account, livemode: envelope.livemode,
        objectId: materialString(envelope?.data?.object?.id), apiVersion: materialString(envelope.api_version) },
      obligation: stripeRefetchObligation(identity, envelope, eventTargets(type)) })
  },
})
