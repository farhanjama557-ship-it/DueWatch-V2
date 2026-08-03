import { fieldLabel } from '../../lib/import/fields.js'
import { categorizeIssue, issueDisplayMessage, ISSUE_CATEGORY } from '../../lib/importUiCopy.js'

const CATEGORY_LABEL = {
  [ISSUE_CATEGORY.RESOLVABLE]: 'Can be resolved here',
  [ISSUE_CATEGORY.SOURCE_CORRECTION]: 'Needs a source-file correction',
  [ISSUE_CATEGORY.INSPECT_ONLY]: 'For your review',
  [ISSUE_CATEGORY.INFORMATIONAL]: 'Informational',
}

function ValueList({ title, values }) {
  const entries = Object.entries(values).filter(([, v]) => v !== undefined)
  if (entries.length === 0) return null
  return (
    <div className="import-detail-block">
      <h5>{title}</h5>
      <dl className="import-detail-list">
        {entries.map(([key, value]) => (
          <div className="import-detail-row" key={key}>
            <dt>{fieldLabel(key)}</dt>
            <dd>{value == null || value === '' ? '—' : String(value)}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

// Never renders row.duplicateKey — the internal duplicate-matching key is
// not founder-facing under any circumstance; duplicate issues already
// carry a human explanation in their message.
export default function RowDetail({ row, headers }) {
  const mappingEntries = Object.entries(row.mapping || {}).map(([colIndex, fieldKey]) => ({
    colIndex: Number(colIndex),
    header: headers[Number(colIndex)] ?? `Column ${Number(colIndex) + 1}`,
    fieldKey,
  }))

  return (
    <div className="import-row-detail">
      <div className="import-detail-block">
        <h5>Source</h5>
        <dl className="import-detail-list">
          <div className="import-detail-row">
            <dt>Source row</dt>
            <dd>{row.originalRowNumber}</dd>
          </div>
          <div className="import-detail-row">
            <dt>Worksheet</dt>
            <dd>{row.sourceSheet}</dd>
          </div>
        </dl>
      </div>

      <div className="import-detail-block">
        <h5>Mapping</h5>
        <dl className="import-detail-list">
          {mappingEntries.map(({ colIndex, header, fieldKey }) => (
            <div className="import-detail-row" key={colIndex}>
              <dt>{header}</dt>
              <dd>{fieldLabel(fieldKey)}</dd>
            </div>
          ))}
        </dl>
      </div>

      <ValueList title="Raw values" values={row.raw} />
      <ValueList title="Normalized values" values={row.normalized} />

      {row.issues.length > 0 && (
        <div className="import-detail-block">
          <h5>Issues</h5>
          <ul className="import-detail-issues">
            {row.issues.map((issue, i) => (
              <li key={i} className="import-detail-issue">
                <p>{issueDisplayMessage(issue)}</p>
                <p className="import-detail-issue-meta">
                  {CATEGORY_LABEL[categorizeIssue(issue)]}
                  {issue.rawValue != null && typeof issue.rawValue === 'string' && issue.rawValue.startsWith('=') && (
                    <> — formula: <code>{issue.rawValue}</code></>
                  )}
                </p>
                <details className="import-detail-issue-tech">
                  <summary>Developer detail</summary>
                  <code>{issue.code}</code>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
