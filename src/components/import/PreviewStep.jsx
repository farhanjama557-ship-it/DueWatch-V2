import { useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { OUTCOMES } from '../../lib/import/outcome.js'
import { OUTCOME_META, OUTCOME_FILTERS } from '../../lib/importUiCopy.js'
import RowTable from './RowTable.jsx'

const FILTER_ALL = 'all'

export default function PreviewStep({ result, headers, onBack, onFinish, onInspectReview, onInspectRejected }) {
  const [filter, setFilter] = useState(FILTER_ALL)

  const filteredRows = useMemo(() => {
    if (filter === FILTER_ALL) return result.rows
    return result.rows.filter((r) => r.outcome === filter)
  }, [result.rows, filter])

  return (
    <div className="brief-card">
      <div className="import-summary-total">
        <span className="import-summary-num">{result.summary.total}</span>
        <span className="import-summary-label">rows read</span>
      </div>
      <div className="import-outcome-cards" role="group" aria-label="Preview outcome summary">
        {OUTCOME_FILTERS.map((outcome) => (
          <div className="import-outcome-card" key={outcome}>
            <span className={`import-summary-num tone-${outcome.replace(/_/g, '-')}`}>{result.summary[outcome]}</span>
            <span className="import-summary-label">{OUTCOME_META[outcome].label}</span>
          </div>
        ))}
      </div>

      <div className="import-filter-bar" role="group" aria-label="Filter rows by outcome">
        <button className={filter === FILTER_ALL ? 'btn-outline btn-inline active' : 'btn-outline btn-inline'} onClick={() => setFilter(FILTER_ALL)}>
          All rows
        </button>
        {OUTCOME_FILTERS.map((outcome) => (
          <button
            key={outcome}
            className={filter === outcome ? 'btn-outline btn-inline active' : 'btn-outline btn-inline'}
            onClick={() => setFilter(outcome)}
          >
            {OUTCOME_META[outcome].label} ({result.summary[outcome]})
          </button>
        ))}
      </div>

      <RowTable rows={filteredRows} headers={headers} totalCount={result.rows.length} emptyMessage="No rows match this filter." />

      <div className="import-preview-footer">
        <button className="btn-outline btn-inline import-btn-back" onClick={onBack}>
          <ArrowLeft width={16} height={16} aria-hidden="true" /> Back
        </button>
        <div className="import-preview-actions">
          {result.summary[OUTCOMES.REVIEW_REQUIRED] > 0 && (
            <button className="btn-outline btn-inline" onClick={onInspectReview}>
              Inspect review-required rows
            </button>
          )}
          {result.summary[OUTCOMES.REJECTED] > 0 && (
            <button className="btn-outline btn-inline" onClick={onInspectRejected}>
              Inspect rejected rows
            </button>
          )}
          <button className="btn-terracotta btn-inline" onClick={onFinish}>
            Finish preview
          </button>
        </div>
      </div>
    </div>
  )
}
