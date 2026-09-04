import {
  PROVIDER_TRUTH_DIMENSION as T, CLAIM_SOURCE_OWNER as OWNER,
} from '../../integrations/providerTruthModel.js'
import {
  ACCOUNTING_ADAPTER_WRITE_SUPPORT, finiteAmount, freeze, materialString,
  refetchObligation, requireConnectionIdentity,
} from './accountingAdapterCommon.js'

export const QUICKBOOKS_ONLINE_PROVIDER = 'quickbooks_online'

function linkedTransactions(payload) {
  const lines = Array.isArray(payload?.Line) ? payload.Line : []
  const lineLinks = lines.flatMap((line) => (Array.isArray(line?.LinkedTxn) ? line.LinkedTxn : [])
    .map((link) => ({ ...link, allocationAmount: finiteAmount(line.Amount) })))
  const topLevelLinks = (Array.isArray(payload?.LinkedTxn) ? payload.LinkedTxn : [])
    .map((link) => ({ ...link, allocationAmount: null }))
  return [...lineLinks, ...topLevelLinks]
    .map((link) => freeze({ txnId: materialString(link.TxnId), txnType: materialString(link.TxnType),
      allocationAmount: link.allocationAmount }))
    .filter((link) => link.txnId && link.txnType)
}

function currency(payload) {
  return materialString(payload?.CurrencyRef?.value)
}

function invoiceInterpretation(observation) {
  const p = observation.rawPayload
  return freeze({
    truthDimension: T.T1_INVOICE_AR_STATE, sourceOwner: OWNER.LEDGER_SOURCE,
    subject: materialString(p.Id),
    value: {
      externalInvoiceId: materialString(p.Id), invoiceNumber: materialString(p.DocNumber),
      customerId: materialString(p.CustomerRef?.value), balance: finiteAmount(p.Balance),
      total: finiteAmount(p.TotalAmt), currency: currency(p), exchangeRate: finiteAmount(p.ExchangeRate),
      transactionDate: materialString(p.TxnDate),
      dueDate: materialString(p.DueDate), syncToken: materialString(p.SyncToken),
      updatedAt: materialString(p.MetaData?.LastUpdatedTime), providerStatus: materialString(p.TxnStatus),
      voided: p.TxnStatus === 'Voided' || p.voided === true, deleted: p.deleted === true,
      linkedTransactions: linkedTransactions(p),
    },
    uncertainty: p.Balance == null ? ['INVOICE_BALANCE_MISSING'] : [],
  })
}

function allocationInterpretation(observation, kind) {
  const p = observation.rawPayload
  const links = linkedTransactions(p)
  const invoiceLinks = links.filter((link) => link.txnType === 'Invoice')
  const total = finiteAmount(p.TotalAmt)
  const unapplied = finiteAmount(p.UnappliedAmt ?? p.RemainingCredit)
  return freeze({
    truthDimension: T.T4_PAYMENT_CREDIT_ALLOCATION_STATE, sourceOwner: OWNER.LEDGER_SOURCE,
    subject: invoiceLinks.length === 1 ? invoiceLinks[0].txnId : `customer:${materialString(p.CustomerRef?.value) ?? 'unknown'}`,
    value: {
      allocationKind: kind, externalObjectId: materialString(p.Id), customerId: materialString(p.CustomerRef?.value),
      total, unapplied, currency: currency(p), exchangeRate: finiteAmount(p.ExchangeRate), invoiceLinks,
      allLinks: links, deleted: p.deleted === true, voided: p.TxnStatus === 'Voided' || p.voided === true,
      updatedAt: materialString(p.MetaData?.LastUpdatedTime), syncToken: materialString(p.SyncToken),
      provesProcessorReceipt: false,
    },
    uncertainty: invoiceLinks.length === 0 ? ['NO_INVOICE_ALLOCATION_LINK'] : [],
  })
}

export const quickBooksOnlineAdapter = freeze({
  provider: QUICKBOOKS_ONLINE_PROVIDER,
  sourceOwner: OWNER.LEDGER_SOURCE,
  supportedByDuewatchAdapter: freeze({ read: 'YES', write: ACCOUNTING_ADAPTER_WRITE_SUPPORT }),
  providerAccountIdentity: 'QBO_REALM_ID_FROM_CONNECTION_CONTEXT',
  createObservationInput({ connection, objectType, payload, observedAt, eventId = null, deliveryId = null }) {
    const identity = requireConnectionIdentity(connection, QUICKBOOKS_ONLINE_PROVIDER)
    const externalObjectId = materialString(payload?.Id)
    if (!externalObjectId) throw new Error('QuickBooks object Id required')
    return freeze({ ...identity, objectType, externalObjectId,
      rawPayload: JSON.parse(JSON.stringify(payload)),
      providerTimestamp: materialString(payload?.MetaData?.LastUpdatedTime), observedAt,
      eventId, deliveryId, apiVersion: 'QBO Accounting API v3' })
  },
  interpretFor(observation) {
    if (observation.provider !== QUICKBOOKS_ONLINE_PROVIDER) throw new Error('wrong provider observation')
    if (observation.objectType === 'Invoice') return invoiceInterpretation(observation)
    if (observation.objectType === 'Payment') return allocationInterpretation(observation, 'PAYMENT')
    if (observation.objectType === 'CreditMemo') return allocationInterpretation(observation, 'CREDIT_MEMO')
    throw new Error(`unsupported QuickBooks object type: ${observation.objectType}`)
  },
  parseChangeEvent({ connection, envelope }) {
    const identity = requireConnectionIdentity(connection, QUICKBOOKS_ONLINE_PROVIDER)
    // Intuit's mandatory 2026 format is an array of CloudEvents. CP2 also
    // accepts the earlier envelope solely as a deterministic replay shape;
    // neither shape is financial truth.
    if (Array.isArray(envelope)) {
      if (envelope.length === 0 || envelope.some((event) =>
        materialString(event?.intuitaccountid) !== identity.providerAccountId)) {
        return freeze({ accepted: false, reason: 'REJECTED_REALM', stateWrittenFromEvent: false })
      }
      const entities = envelope.map((event) => {
        const eventType = materialString(event.type) ?? ''
        const name = materialString(event?.data?.entityName) ??
          (eventType.match(/(?:^|\.)(invoice|payment|creditmemo)(?:\.|$)/i)?.[1] ?? 'Unknown')
        return { name: name[0].toUpperCase() + name.slice(1),
          id: materialString(event.intuitentityid),
          operation: materialString(event?.data?.operation) ?? eventType.split('.').at(-1),
          lastUpdated: materialString(event.time), eventId: materialString(event.id) }
      })
      const targets = entities.flatMap((entity) => {
        if (entity.name.toLowerCase() === 'invoice') return ['invoice', 'allocations']
        if (['payment', 'creditmemo'].includes(entity.name.toLowerCase())) {
          return ['payment', 'invoice', 'allocations', 'customer_unapplied_value']
        }
        return ['invoice', 'payment', 'allocations', 'customer_unapplied_value']
      })
      return freeze({ accepted: true, eventFormat: 'CLOUDEVENTS_1_0', eventEntities: entities,
        obligation: refetchObligation({ provider: identity.provider,
          providerAccountId: identity.providerAccountId,
          eventId: entities.map((entity) => entity.eventId ?? `${entity.name}:${entity.id}`).join('|'),
          targets, reason: 'QuickBooks CloudEvent invalidates cached accounting state; authoritative reread required.' }) })
    }
    const notifications = Array.isArray(envelope?.eventNotifications)
      ? envelope.eventNotifications : []
    if (notifications.length === 0 || notifications.some((notification) =>
      materialString(notification?.realmId) !== identity.providerAccountId)) {
      return freeze({ accepted: false, reason: 'REJECTED_REALM', stateWrittenFromEvent: false })
    }
    const entities = notifications.flatMap((notification) =>
      notification?.dataChangeEvent?.entities ?? [])
    const targets = entities.flatMap((entity) => {
      if (entity.name === 'Invoice') return ['invoice', 'allocations']
      if (entity.name === 'Payment' || entity.name === 'CreditMemo') {
        return ['payment', 'invoice', 'allocations', 'customer_unapplied_value']
      }
      return ['invoice', 'payment', 'allocations', 'customer_unapplied_value']
    })
    return freeze({ accepted: true, eventFormat: 'LEGACY_REPLAY_ONLY', eventEntities: entities.map((entity) => ({
      name: entity.name, id: entity.id, operation: entity.operation,
      lastUpdated: entity.lastUpdated,
    })), obligation: refetchObligation({ provider: identity.provider,
      providerAccountId: identity.providerAccountId,
      eventId: entities.map((entity) => `${entity.name}:${entity.id}:${entity.lastUpdated}`).join('|'),
      targets, reason: 'QuickBooks event invalidates cached accounting state; authoritative reread required.' }) })
  },
})
