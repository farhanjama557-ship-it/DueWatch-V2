import DwLiveBadge from './DwLiveBadge'
import DwLiveFeed from './DwLiveFeed'
import { presentPulseCommand, resolveDwInvoice, formatDwMoney } from '../../lib/dwIntelligence/phase2bUiPresentation'
import './dwIntelligencePhase2b.css'

function invoiceLabel(invoice, fallbackId) {
  if (!invoice) return fallbackId || 'Invoice'
  const client = invoice.clients?.name || 'Client'
  const number = invoice.invoice_number || invoice.inv_num || 'Invoice'
  return `${client} · ${number}`
}

export default function DwPulseIntelligence({ model, invoices = [], onOpenInvoice }) {
  const view = presentPulseCommand(model)
  if (!view) return null

  const liveEntries = [
    ...(model.livePresence?.caseBacked || []),
    ...(model.livePresence?.runOnly || []),
  ].slice(0, 3)

  return (
    <section className="dw-command-room" data-dw-read-only="true" aria-label="DW Intelligence command room">
      <div className="dw-command-head">
        <div>
          <div className="dw-command-kicker">DW Intelligence</div>
          <h2>{view.headline}</h2>
        </div>
        <DwLiveBadge model={model} />
      </div>

      <div className="dw-command-metrics">
        {view.metrics.map((metric) => (
          <div key={metric.key} className={metric.attention ? 'dw-command-metric needs-you' : 'dw-command-metric'}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </div>

      {liveEntries.length > 0 && (
        <div className="dw-live-now">
          <div className="dw-live-now-title">DW is working right now</div>
          <ul>
            {liveEntries.map((entry) => {
              const invoice = resolveDwInvoice(invoices, entry.invoiceId)
              return (
                <li key={entry.runId || entry.invoiceId}>
                  <button
                    type="button"
                    className="dw-live-job"
                    onClick={() => onOpenInvoice?.(entry.invoiceId)}
                  >
                    <span className="dw-live-job-dot" aria-hidden="true" />
                    <span className="dw-live-job-main">
                      <strong>{invoiceLabel(invoice, entry.invoiceId)}</strong>
                      <span>{entry.workPhase || 'analyzing'}</span>
                    </span>
                    <span className="dw-live-job-amount">
                      {invoice ? formatDwMoney((Number(invoice.amount) || 0) - (Number(invoice.amount_paid) || 0)) : 'Join DW'}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      <DwLiveFeed
        model={model.liveFeed ?? null}
        onJoin={(target) => target?.kind === 'invoice' && onOpenInvoice?.(target.invoiceId)}
      />
    </section>
  )
}
