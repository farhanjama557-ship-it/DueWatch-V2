import { OUTCOME_META, OUTCOME_FILTERS } from '../../lib/importUiCopy.js'

export default function CompleteStep({ summary, onStartOver }) {
  return (
    <div className="brief-card" aria-live="polite">
      <div className="import-summary">
        {OUTCOME_FILTERS.map((outcome) => (
          <div className="import-summary-item" key={outcome}>
            <span className={`import-summary-num tone-${outcome.replace(/_/g, '-')}`}>{summary[outcome]}</span>
            <span className="import-summary-label">{OUTCOME_META[outcome].label}</span>
          </div>
        ))}
      </div>
      <p className="import-help">
        Nothing has been saved to your account. Unresolved and rejected rows cannot proceed until they're fixed and
        re-previewed.
      </p>
      <button className="btn-outline btn-inline" onClick={onStartOver}>
        Start over
      </button>
    </div>
  )
}
