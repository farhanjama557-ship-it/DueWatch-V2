import { presentCaseState } from '../../lib/dwIntelligence/phase2bUiPresentation'
import './dwIntelligencePhase2b.css'

export default function DwInvoiceIntelligencePanel({ model }) {
  const view = presentCaseState(model)
  if (!view) return null

  return (
    <section className="dw-case-file" data-dw-read-only="true" aria-label="DW Intelligence case file">
      <div className="dw-case-file-head">
        <div>
          <span className="dw-case-kicker">DW Intelligence</span>
          <strong>{view.live ? `● ${view.workPhase || 'working'}` : view.label}</strong>
        </div>
        <span className={`dw-case-state state-${view.state.toLowerCase()}`}>{view.label}</span>
      </div>

      <p className="dw-case-message">{view.message}</p>

      <div className="dw-case-proof-row">
        <span>{view.authorityLabel}</span>
        <span>{view.evidenceLabel}</span>
      </div>

      {model.recommendation && (
        <div className="dw-case-next">
          <span>DW recommendation</span>
          <strong>
            {model.recommendation.action || 'Review'}
            {model.recommendation.tone ? ` · ${model.recommendation.tone}` : ''}
          </strong>
        </div>
      )}

      {Array.isArray(model.why) && model.why.length > 0 && (
        <details className="dw-case-details">
          <summary>Why?</summary>
          <ul>
            {model.why.map((item, index) => <li key={`${item.type || 'why'}-${index}`}>{item.text}</li>)}
          </ul>
        </details>
      )}

      {model.evidence && (
        <details className="dw-case-details">
          <summary>Evidence</summary>
          <div className="dw-evidence-grid">
            <span>Admitted <strong>{model.evidence.admitted || 0}</strong></span>
            <span>Context <strong>{model.evidence.contextOnly || 0}</strong></span>
            <span>Excluded <strong>{(model.evidence.rejected || 0) + (model.evidence.quarantined || 0)}</strong></span>
            <span>Strong roots <strong>{model.evidence.independentStrongRoots || 0}</strong></span>
          </div>
        </details>
      )}

      {model.needsFounder && (
        <div className="dw-case-founder-boundary">
          <strong>Needs your judgment</strong>
          <span>Any approval must be revalidated by the server before execution.</span>
        </div>
      )}

      {view.proofMode && <div className="dw-case-proof-mode">{view.proofMode}</div>}
    </section>
  )
}
