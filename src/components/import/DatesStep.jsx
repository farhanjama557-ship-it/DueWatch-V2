import { useMemo, useState } from 'react'
import { AlertTriangle, ArrowLeft } from 'lucide-react'
import { fieldLabel } from '../../lib/import/fields.js'
import { classifyNumericDate, resolveAmbiguousNumericDate } from '../../lib/import/dates.js'
import { groupDateIssuesByField, DATE_DECISION_FIELDS } from '../../lib/importUiCopy.js'
import { formatShortDate } from '../../lib/format.js'

function headerForColumn(headers, columnId) {
  if (columnId == null) return null
  return headers[columnId] ?? `Column ${columnId + 1}`
}

function interpretedExamples(rawValue) {
  const classification = classifyNumericDate(String(rawValue).trim())
  if (!classification || classification.kind !== 'ambiguous') return null
  const mdy = resolveAmbiguousNumericDate(classification, 'MDY')
  const dmy = resolveAmbiguousNumericDate(classification, 'DMY')
  return {
    mdy: mdy ? formatShortDate(mdy) : 'not a valid date',
    dmy: dmy ? formatShortDate(dmy) : 'not a valid date',
  }
}

function AmbiguousFieldGroup({ fieldKey, entries, headers, choice, onChoose }) {
  const columnId = entries[0]?.issue.columnId
  const uniqueRawValues = [...new Set(entries.map((e) => e.issue.rawValue))].slice(0, 5)
  const example = interpretedExamples(uniqueRawValues[0])

  return (
    <div className="import-date-group">
      <h4>{fieldLabel(fieldKey)}</h4>
      <p className="import-help">
        Column "{headerForColumn(headers, columnId)}" — {entries.length} row{entries.length === 1 ? '' : 's'} affected.
      </p>
      <p className="import-help">Sample values: {uniqueRawValues.join(', ')}</p>
      <fieldset className="import-date-choice">
        <legend className="sr-only">Date order for {fieldLabel(fieldKey)}</legend>
        <label className="import-header-toggle">
          <input type="radio" name={`date-${fieldKey}`} checked={choice === 'MDY'} onChange={() => onChoose(fieldKey, 'MDY')} />
          Month / Day / Year{example ? ` — e.g. ${uniqueRawValues[0]} → ${example.mdy}` : ''}
        </label>
        <label className="import-header-toggle">
          <input type="radio" name={`date-${fieldKey}`} checked={choice === 'DMY'} onChange={() => onChoose(fieldKey, 'DMY')} />
          Day / Month / Year{example ? ` — e.g. ${uniqueRawValues[0]} → ${example.dmy}` : ''}
        </label>
      </fieldset>
    </div>
  )
}

function MixedFieldGroup({ fieldKey, entries, headers }) {
  const columnId = entries[0]?.issue.columnId
  const sample = entries.slice(0, 5)
  return (
    <div className="import-date-group import-date-group-mixed">
      <h4>{fieldLabel(fieldKey)}</h4>
      <p className="import-help">
        <AlertTriangle width={14} height={14} aria-hidden="true" /> Column "{headerForColumn(headers, columnId)}"
        mixes Month/Day/Year and Day/Month/Year dates. Duewatch will not guess which rows mean what.
      </p>
      <ul className="import-date-mixed-rows">
        {sample.map(({ row, issue }) => (
          <li key={row.originalRowNumber}>
            Row {row.originalRowNumber}: "{issue.rawValue}"
          </li>
        ))}
      </ul>
      <p className="import-help">
        Correct the source file so this column uses one consistent date order, then re-upload. Rows in this column
        using ISO (YYYY-MM-DD) or a named month may still be usable; other date fields are unaffected.
      </p>
    </div>
  )
}

export default function DatesStep({ rows, headers, dateConvention, onConfirm, onBack }) {
  const ambiguousByField = useMemo(() => groupDateIssuesByField(rows, ['AMBIGUOUS_DATE_FORMAT']), [rows])
  const mixedByField = useMemo(() => groupDateIssuesByField(rows, ['MIXED_DATE_FORMATS']), [rows])
  const [pending, setPending] = useState(dateConvention)

  const fieldsNeedingChoice = DATE_DECISION_FIELDS.filter((f) => ambiguousByField[f].length > 0)
  const allChosen = fieldsNeedingChoice.every((f) => pending[f] === 'MDY' || pending[f] === 'DMY')

  function choose(fieldKey, convention) {
    setPending((cur) => ({ ...cur, [fieldKey]: convention }))
  }

  return (
    <div className="brief-card">
      <p className="import-help">Some date columns need a decision before Duewatch can read them.</p>

      {fieldsNeedingChoice.map((fieldKey) => (
        <AmbiguousFieldGroup
          key={fieldKey}
          fieldKey={fieldKey}
          entries={ambiguousByField[fieldKey]}
          headers={headers}
          choice={pending[fieldKey]}
          onChoose={choose}
        />
      ))}

      {DATE_DECISION_FIELDS.filter((f) => mixedByField[f].length > 0).map((fieldKey) => (
        <MixedFieldGroup key={fieldKey} fieldKey={fieldKey} entries={mixedByField[fieldKey]} headers={headers} />
      ))}

      <div className="import-preview-footer">
        <button className="btn-outline btn-inline" onClick={onBack}>
          <ArrowLeft width={16} height={16} aria-hidden="true" /> Back
        </button>
        <button className="btn-terracotta btn-inline" disabled={!allChosen} onClick={() => onConfirm(pending)}>
          {fieldsNeedingChoice.length > 0 ? 'Confirm dates' : 'Continue'}
        </button>
      </div>
    </div>
  )
}
