import { resolveDwInvoice } from '../../lib/dwIntelligence/phase2bUiPresentation'
import './dwIntelligencePhase2b.css'

function labelFor(invoice, fallback) {
  if (!invoice) return fallback || 'Invoice'
  return `${invoice.clients?.name || 'Client'} · ${invoice.invoice_number || invoice.inv_num || 'Invoice'}`
}

function readableTime(value) {
  if (!value) return 'Time unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Time unavailable'
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date)
}

export default function DwWhatsDoneJournal({ model, invoices = [], onOpenInvoice }) {
  if (!model) return null

  return (
    <section className="dw-work-journal" data-dw-read-only="true" aria-label="DW What's Done">
      <div className="dw-work-journal-head">
        <div>
          <span className="dw-command-kicker">What&apos;s Done</span>
          <h2>DW work journal</h2>
          <p>Completed, investigated, escalated, watched, and intentionally withheld work — with proof.</p>
        </div>
        <div className="dw-work-journal-integrity">
          <strong>{model.total || 0}</strong>
          <span>proven entries</span>
        </div>
      </div>

      {model.total === 0 ? (
        <p className="dw-work-journal-empty">No completed DW proof entries yet.</p>
      ) : (
        <>
          <div className="dw-work-journal-summary">
            <span>{model.summary?.handled || 0} handled</span>
            <span>{model.summary?.investigated || 0} investigated</span>
            <span>{model.summary?.escalated || 0} escalated</span>
            <span>{model.summary?.withheld || 0} withheld</span>
            <span>{model.summary?.realSideEffects || 0} real side effects</span>
          </div>

          <ul className="dw-work-journal-list">
            {model.entries.map((entry) => {
              const invoice = resolveDwInvoice(invoices, entry.invoiceId)
              const rowContent = (
                <>
                  <span className={`dw-work-kind kind-${String(entry.kind || '').toLowerCase()}`}>{entry.kind}</span>
                  <span className="dw-work-journal-main">
                    <strong>{entry.title}</strong>
                    <span>{labelFor(invoice, entry.invoiceId)}</span>
                    <small>{entry.detail}</small>
                  </span>
                  <span className="dw-work-journal-proof">
                    <span>{readableTime(entry.at)}</span>
                    <small>{entry.proofAvailable ? 'Proof available' : 'Proof unavailable'}</small>
                  </span>
                </>
              )
              return (
                <li key={`${entry.runId || entry.invoiceId}-${entry.at || ''}`}>
                  {typeof onOpenInvoice === 'function' ? (
                    <button type="button" className="dw-work-journal-row" onClick={() => onOpenInvoice(entry.invoiceId)}>
                      {rowContent}
                    </button>
                  ) : (
                    <div className="dw-work-journal-row">{rowContent}</div>
                  )}
                  {Array.isArray(entry.why) && entry.why.length > 0 && (
                    <details className="dw-work-journal-why">
                      <summary>Why</summary>
                      <ul>
                        {entry.why.slice(0, 4).map((reason, index) => <li key={`${reason.type || 'reason'}-${index}`}>{reason.text}</li>)}
                      </ul>
                    </details>
                  )}
                </li>
              )
            })}
          </ul>
        </>
      )}

      <p className="dw-command-footnote">
        This journal is a read-only proof surface. It cannot send reminders, change invoices, or grant authority.
      </p>
    </section>
  )
}
