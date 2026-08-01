import { Fragment, useState } from 'react'
import { PREVIEW_DISPLAY_CAP } from '../../lib/import/limits.js'
import { OUTCOME_META, formatMoneyWithCurrency, clientIdentityLabel, issueDisplayMessage } from '../../lib/importUiCopy.js'
import { formatShortDate } from '../../lib/format.js'
import RowDetail from './RowDetail.jsx'

function OutcomeBadge({ outcome }) {
  const meta = OUTCOME_META[outcome] || { label: outcome, symbol: '' }
  return (
    <span className={`import-status-badge status-${outcome.replace(/_/g, '-')}`}>
      <span aria-hidden="true">{meta.symbol}</span> {meta.label}
    </span>
  )
}

function issuesSummary(row) {
  if (row.issues.length === 0) return '—'
  const first = issueDisplayMessage(row.issues[0])
  if (row.issues.length === 1) return first
  return `${first} (+${row.issues.length - 1} more)`
}

// Renders at most PREVIEW_DISPLAY_CAP of `rows` — the caller is
// responsible for filtering over the FULL row set first; this component
// only ever slices for render, never for the counts it's given.
export default function RowTable({ rows, headers, totalCount, emptyMessage }) {
  const [expandedKey, setExpandedKey] = useState(null)
  const visible = rows.slice(0, PREVIEW_DISPLAY_CAP)

  if (rows.length === 0) {
    return <p className="import-help">{emptyMessage || 'No rows match this filter.'}</p>
  }

  return (
    <div>
      <div className="list-card import-preview-table-wrap">
        <table className="invoice-table import-preview-table">
          <colgroup>
            <col className="col-status" />
            <col className="col-client" />
            <col className="col-invnum" />
            <col className="col-due" />
            <col className="col-amount" />
            <col className="col-issues" />
          </colgroup>
          <thead>
            <tr>
              <th>Outcome</th>
              <th>Client</th>
              <th>Invoice #</th>
              <th>Invoice / Due Date</th>
              <th className="ta-right">Amount</th>
              <th>Issues</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const key = row.originalRowNumber
              const expanded = expandedKey === key
              return (
                <Fragment key={key}>
                  <tr className={`import-row-${row.outcome.replace(/_/g, '-')}`}>
                    <td><OutcomeBadge outcome={row.outcome} /></td>
                    <td>{clientIdentityLabel(row.normalized)}</td>
                    <td className="cell-muted">{row.normalized.invoice_number || '—'}</td>
                    <td className="cell-muted">
                      {row.normalized.invoice_date ? formatShortDate(row.normalized.invoice_date) : '—'}
                      {' / '}
                      {row.normalized.due_date ? formatShortDate(row.normalized.due_date) : '—'}
                    </td>
                    <td className="ta-right cell-amount">{formatMoneyWithCurrency(row.normalized.amount, row.normalized.currency)}</td>
                    <td className="import-issues">
                      {issuesSummary(row)}{' '}
                      <button
                        type="button"
                        className="import-row-expand-toggle"
                        aria-expanded={expanded}
                        aria-controls={`import-row-detail-${key}`}
                        onClick={() => setExpandedKey(expanded ? null : key)}
                      >
                        {expanded ? 'Hide details' : 'Details'}
                      </button>
                    </td>
                  </tr>
                  {expanded && (
                    <tr>
                      <td colSpan={6} id={`import-row-detail-${key}`}>
                        <RowDetail row={row} headers={headers} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      {rows.length > PREVIEW_DISPLAY_CAP && (
        <p className="import-help">
          Showing the first {PREVIEW_DISPLAY_CAP} of {rows.length} matching rows. All {totalCount ?? rows.length} rows
          are included in the summary above.
        </p>
      )}
    </div>
  )
}
