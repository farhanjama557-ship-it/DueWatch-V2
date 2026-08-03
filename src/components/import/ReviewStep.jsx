import { ArrowLeft } from 'lucide-react'
import { OUTCOMES } from '../../lib/import/outcome.js'
import {
  rowsWithOutcome,
  groupRowsByPrimaryIssueCode,
  categorizeIssue,
  issueDisplayMessage,
  ISSUE_CATEGORY,
  clientIdentityLabel,
} from '../../lib/importUiCopy.js'

const CATEGORY_EXPLAINER = {
  [ISSUE_CATEGORY.RESOLVABLE]: 'This can still be resolved in this preview.',
  [ISSUE_CATEGORY.SOURCE_CORRECTION]: 'This needs to be corrected in the source file and re-uploaded.',
  [ISSUE_CATEGORY.INSPECT_ONLY]: 'This is for your review — no source-file change is required.',
  [ISSUE_CATEGORY.INFORMATIONAL]: 'This is informational only.',
}

export default function ReviewStep({ result, onBack, onGoToDates }) {
  const rows = rowsWithOutcome(result.rows, OUTCOMES.REVIEW_REQUIRED)
  const groups = groupRowsByPrimaryIssueCode(rows)

  return (
    <div className="brief-card">
      <p className="import-help">
        {rows.length === 1
          ? '1 row needs a decision before it can proceed. Grouped by the reason below.'
          : `${rows.length} rows need a decision before they can proceed. Grouped by the reason below.`}
      </p>

      {[...groups.entries()].map(([code, groupRows]) => {
        const sampleIssue = groupRows[0].issues.find((i) => i.code === code) || groupRows[0].issues[0]
        const category = categorizeIssue(sampleIssue)
        return (
          <div className="import-issue-group" key={code}>
            <h4>{issueDisplayMessage(sampleIssue)}</h4>
            <p className="import-help">
              {groupRows.length} row{groupRows.length === 1 ? '' : 's'} — {CATEGORY_EXPLAINER[category]}
            </p>
            <ul className="import-issue-group-rows">
              {groupRows.slice(0, 10).map((row) => (
                <li key={row.originalRowNumber}>
                  Row {row.originalRowNumber} — {clientIdentityLabel(row.normalized)}
                  {row.normalized.invoice_number ? ` (${row.normalized.invoice_number})` : ''}
                </li>
              ))}
              {groupRows.length > 10 && <li>…and {groupRows.length - 10} more.</li>}
            </ul>
            {code === 'AMBIGUOUS_DATE_FORMAT' && (
              <button className="btn-outline btn-inline" onClick={onGoToDates}>
                Make a date decision
              </button>
            )}
          </div>
        )
      })}

      <div className="import-preview-footer">
        <button className="btn-outline btn-inline import-btn-back" onClick={onBack}>
          <ArrowLeft width={16} height={16} aria-hidden="true" /> Back to preview
        </button>
      </div>
    </div>
  )
}
