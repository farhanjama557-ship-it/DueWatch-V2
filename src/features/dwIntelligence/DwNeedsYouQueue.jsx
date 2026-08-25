import { formatDwMoney, resolveDwInvoice } from '../../lib/dwIntelligence/phase2bUiPresentation'
import './dwIntelligencePhase2b.css'

function labelFor(invoice, fallback) {
  if (!invoice) return fallback || 'Invoice'
  return `${invoice.clients?.name || 'Client'} · ${invoice.invoice_number || invoice.inv_num || 'Invoice'}`
}

export default function DwNeedsYouQueue({ model, invoices = [], onOpenInvoice }) {
  if (!model || !Array.isArray(model.items) || model.items.length === 0) return null

  return (
    <section className="dw-command-queue" data-dw-read-only="true" aria-label="DW Needs You command queue">
      <div className="dw-command-queue-head">
        <div>
          <span className="dw-command-kicker">Needs You</span>
          <h2>{model.count} {model.count === 1 ? 'decision needs' : 'decisions need'} your judgment</h2>
        </div>
        <span className="dw-command-queue-count">{model.count}</span>
      </div>

      <ul className="dw-command-queue-list">
        {model.items.map((item) => {
          const invoice = resolveDwInvoice(invoices, item.invoiceId)
          return (
            <li key={item.runId || item.invoiceId}>
              <button type="button" onClick={() => onOpenInvoice?.(item.invoiceId)}>
                <span className="dw-command-queue-main">
                  <strong>{labelFor(invoice, item.invoiceId)}</strong>
                  <small>{item.stateMessage}</small>
                  {item.recommendation?.action && (
                    <span className="dw-command-recommendation">
                      DW recommends: {String(item.recommendation.action).replaceAll('_', ' ')}
                      {item.recommendation.tone ? ` · ${item.recommendation.tone}` : ''}
                    </span>
                  )}
                </span>
                <span className="dw-command-queue-side">
                  <strong>{formatDwMoney(item.balance)}</strong>
                  <span>{item.cta || 'Review case'}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>

      <p className="dw-command-footnote">
        You are reviewing the case, not granting browser authority. Any execution requires current server-side revalidation.
      </p>
    </section>
  )
}
