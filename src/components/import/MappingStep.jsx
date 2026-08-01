import { AlertTriangle } from 'lucide-react'
import { TARGET_FIELDS, IGNORE_KEY, fieldLabel } from '../../lib/import/fields.js'

function originLabel(origin) {
  if (origin === 'suggested') return 'Suggested by Duewatch'
  if (origin === 'chosen') return 'Chosen by you'
  return 'Not mapped'
}

export default function MappingStep({ headers, sampleRows, mapping, mappingOrigin, validation, onMappingChange, onContinue }) {
  return (
    <div className="brief-card">
      <p className="import-help">
        Map each column to a Duewatch field, or leave it unmapped. Nothing here is saved — you can change any of
        this later.
      </p>

      <div className="import-mapper">
        {headers.map((header, colIndex) => {
          const fieldKey = mapping[colIndex] ?? IGNORE_KEY
          const origin = colIndex in mapping ? mappingOrigin[colIndex] : null
          const selectId = `import-map-col-${colIndex}`
          return (
            <div className="import-mapper-col" key={colIndex}>
              <label className="import-mapper-header" htmlFor={selectId}>
                {header || `Column ${colIndex + 1}`}
              </label>
              <select
                id={selectId}
                value={fieldKey}
                onChange={(e) => onMappingChange(colIndex, e.target.value)}
              >
                <option value={IGNORE_KEY}>Not mapped</option>
                {TARGET_FIELDS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                    {f.required ? ' (required)' : ''}
                  </option>
                ))}
              </select>
              <div className={origin ? `import-mapper-origin origin-${origin}` : 'import-mapper-origin origin-none'}>
                {originLabel(origin)}
              </div>
              <div className="import-mapper-samples">
                {sampleRows.map((row, i) => (
                  <div key={i} className="import-mapper-sample">
                    {row[colIndex] || '—'}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {validation.missingRequiredFields.length > 0 && (
        <p className="import-error import-error-block">
          <AlertTriangle width={14} height={14} aria-hidden="true" />
          Still needs a column: {validation.missingRequiredFields.map((k) => fieldLabel(k)).join(', ')}
        </p>
      )}
      {validation.clientIdentityMissing && (
        <p className="import-error import-error-block">
          <AlertTriangle width={14} height={14} aria-hidden="true" />
          Map at least one way to identify the client: email, name, company, phone with name/company, or a source
          system with source client ID.
        </p>
      )}
      {validation.duplicateTargetFields.length > 0 && (
        <p className="import-error import-error-block">
          <AlertTriangle width={14} height={14} aria-hidden="true" />
          Mapped to more than one column: {validation.duplicateTargetFields.map((k) => fieldLabel(k)).join(', ')}
        </p>
      )}

      <button className="btn-terracotta btn-inline" disabled={!validation.valid} onClick={onContinue}>
        Continue
      </button>
    </div>
  )
}
