import { Link } from 'react-router-dom'

const STATUS_LABELS = {
  starting: 'Starting import…',
  in_progress: 'Saving…',
  completed: 'Import complete',
  partially_completed: 'Import finished — some rows were blocked',
  cancelled: 'Import cancelled',
  failed: 'Import failed',
  batch_failed: 'A batch failed and stopped the import',
  stalled: 'Import did not reach a finished state',
}

const TERMINAL_PHASES = new Set(['completed', 'partially_completed', 'cancelled', 'failed', 'batch_failed', 'stalled', 'error'])

// Deliberately plain: a truthful progress readout and a terminal summary,
// nothing more. No animation, no decorative cards — those are explicitly
// deferred past Checkpoint 1 (see DUEWATCH_CONTEXT_LOG.md).
export default function ExecuteStep({ phase, progress, error, onCancel, canCancel }) {
  const isTerminal = TERMINAL_PHASES.has(phase)

  return (
    <div className="brief-card" aria-live="polite">
      <p className="import-help">
        Your import is saved in groups as it goes. If it stops partway, everything saved so far stays saved —
        nothing is undone.
      </p>

      <h4 className="import-execute-status">{error ? 'Import failed' : STATUS_LABELS[phase] || 'Working…'}</h4>

      {progress && (
        <div className="import-outcome-cards" role="group" aria-label="Import progress">
          <div className="import-outcome-card">
            <span className="import-summary-num">{progress.committedRows}</span>
            <span className="import-summary-label">saved</span>
          </div>
          <div className="import-outcome-card">
            <span className="import-summary-num">{progress.blockedRows}</span>
            <span className="import-summary-label">blocked</span>
          </div>
          <div className="import-outcome-card">
            <span className="import-summary-num">{progress.eligibleRows}</span>
            <span className="import-summary-label">eligible total</span>
          </div>
          <div className="import-outcome-card">
            <span className="import-summary-num">{progress.totalRows}</span>
            <span className="import-summary-label">rows read</span>
          </div>
        </div>
      )}

      {error && <p className="import-error import-error-block">{String(error.message || error)}</p>}
      {progress?.batchFailedReason && (
        <p className="import-error import-error-block">Reason: {progress.batchFailedReason}</p>
      )}

      {!isTerminal && canCancel && (
        <button className="btn-outline btn-inline" onClick={onCancel}>
          Cancel
        </button>
      )}

      {isTerminal && (
        <Link to="/invoices" className="btn-terracotta btn-inline">
          Go to Invoices
        </Link>
      )}
    </div>
  )
}
