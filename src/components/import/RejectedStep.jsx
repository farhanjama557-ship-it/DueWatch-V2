import { ArrowLeft } from 'lucide-react'
import { OUTCOMES } from '../../lib/import/outcome.js'
import {
  rowsWithOutcome,
  groupRowsByPrimaryIssueCode,
  issueDisplayMessage,
  REJECTED_ROW_COPY,
  clientIdentityLabel,
} from '../../lib/importUiCopy.js'
import { fieldLabel } from '../../lib/import/fields.js'

export default function RejectedStep({ result, onBack }) {
  const rows = rowsWithOutcome(result.rows, OUTCOMES.REJECTED)
  const groups = groupRowsByPrimaryIssueCode(rows)

  return (
    <div className="brief-card">
      <p className="import-error import-error-block">{REJECTED_ROW_COPY}</p>
      <p className="import-help">
        The source file needs a correction for these rows before they can be re-uploaded and previewed again.
      </p>

      {[...groups.entries()].map(([code, groupRows]) => {
        const sampleIssue = groupRows[0].issues.find((i) => i.code === code) || groupRows[0].issues[0]
        return (
          <div className="import-issue-group" key={code}>
            <h4>{issueDisplayMessage(sampleIssue)}</h4>
            <p className="import-help">
              {groupRows.length} row{groupRows.length === 1 ? '' : 's'}
              {sampleIssue.field ? ` — field: ${fieldLabel(sampleIssue.field)}` : ''}
            </p>
            <ul className="import-issue-group-rows">
              {groupRows.slice(0, 10).map((row) => {
                const issue = row.issues.find((i) => i.code === code)
                return (
                  <li key={row.originalRowNumber}>
                    Row {row.originalRowNumber} — {clientIdentityLabel(row.normalized)}
                    {issue && issue.rawValue != null ? ` — value: "${issue.rawValue}"` : ''}
                  </li>
                )
              })}
              {groupRows.length > 10 && <li>…and {groupRows.length - 10} more.</li>}
            </ul>
          </div>
        )
      })}

      <div className="import-preview-footer">
        <button className="btn-outline btn-inline" onClick={onBack}>
          <ArrowLeft width={16} height={16} aria-hidden="true" /> Back to preview
        </button>
      </div>
    </div>
  )
}
