import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Upload,
  FileSpreadsheet,
  AlertTriangle,
  ArrowLeft,
  X,
  Loader2,
} from 'lucide-react'
import { parseImportFile } from '../lib/importParse'
import { TARGET_FIELDS, IGNORE_KEY, guessMapping } from '../lib/importFields'
import { normalizeRow, flagDuplicateInvoiceNumbers } from '../lib/importNormalize'
import { formatMoney, formatShortDate } from '../lib/format'

// PR A (this page) is parsing/mapping/normalization/preview only — no
// Supabase calls anywhere in this file. Persistence is PR B, held until
// PR #22's canonical client resolver clears its two readiness blockers
// (disposable Postgres integration test, staging FK verification) and merges.
const IMPORT_DISABLED_REASON =
  "Import is disabled until PR #22's canonical client-matching system is validated and merged. This preview shows exactly what would be imported — nothing here has been written to your account."

const MAX_PREVIEW_ROWS = 200

const STEPS = ['upload', 'sheet', 'map', 'preview']

function StepDots({ step, sheetCount }) {
  const visible = sheetCount > 1 ? STEPS : STEPS.filter((s) => s !== 'sheet')
  const labels = { upload: 'Upload', sheet: 'Sheet', map: 'Map Columns', preview: 'Preview' }
  return (
    <div className="import-steps">
      {visible.map((s, i) => (
        <div key={s} className={s === step ? 'import-step active' : 'import-step'}>
          <span className="import-step-num">{i + 1}</span>
          <span>{labels[s]}</span>
        </div>
      ))}
    </div>
  )
}

function UploadStep({ onFile, error, busy }) {
  const inputRef = useRef(null)
  const [dragOver, setDragOver] = useState(false)

  function handleFiles(files) {
    const file = files?.[0]
    if (file) onFile(file)
  }

  return (
    <div
      className={dragOver ? 'import-dropzone drag-over' : 'import-dropzone'}
      onDragOver={(e) => {
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        handleFiles(e.dataTransfer.files)
      }}
      onClick={() => !busy && inputRef.current?.click()}
      role="button"
      tabIndex={0}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.xlsx"
        hidden
        onChange={(e) => handleFiles(e.target.files)}
      />
      {busy ? (
        <>
          <Loader2 className="import-dropzone-icon spin" />
          <p className="import-dropzone-title">Reading file…</p>
        </>
      ) : (
        <>
          <Upload className="import-dropzone-icon" />
          <p className="import-dropzone-title">Drag a file here, or click to browse</p>
          <p className="import-dropzone-sub">Accepts .csv and .xlsx</p>
        </>
      )}
      {error && (
        <p className="import-error">
          <AlertTriangle width={14} height={14} /> {error}
        </p>
      )}
    </div>
  )
}

function SheetStep({ sheets, selectedIndex, onSelect, onContinue }) {
  return (
    <div className="brief-card">
      <p className="import-help">This file has multiple sheets. Choose the one to import.</p>
      <div className="import-sheet-list">
        {sheets.map((s, i) => (
          <label key={s.name} className={i === selectedIndex ? 'import-sheet-option selected' : 'import-sheet-option'}>
            <input
              type="radio"
              name="sheet"
              checked={i === selectedIndex}
              onChange={() => onSelect(i)}
            />
            <FileSpreadsheet width={16} height={16} />
            <span className="import-sheet-name">{s.name}</span>
            <span className="import-sheet-meta">{s.rows.length} rows</span>
          </label>
        ))}
      </div>
      <button className="btn-terracotta btn-inline" onClick={onContinue}>
        Continue
      </button>
    </div>
  )
}

function MapStep({ headers, sampleRows, mapping, onMappingChange, hasHeaderRow, onToggleHeaderRow, onContinue }) {
  const usedFields = useMemo(() => {
    const counts = {}
    Object.values(mapping).forEach((key) => {
      if (key === IGNORE_KEY) return
      counts[key] = (counts[key] || 0) + 1
    })
    return counts
  }, [mapping])

  const missingRequired = TARGET_FIELDS.filter(
    (f) => f.required && !Object.values(mapping).includes(f.key)
  )
  const duplicateFields = Object.entries(usedFields).filter(([, count]) => count > 1)

  return (
    <div className="brief-card">
      <label className="import-header-toggle">
        <input type="checkbox" checked={hasHeaderRow} onChange={(e) => onToggleHeaderRow(e.target.checked)} />
        First row is column headers
      </label>
      <p className="import-help">
        Map each column below to a Duewatch field, or leave it ignored. Dates are read as
        Month/Day/Year unless the values clearly require Day/Month/Year.
      </p>

      <div className="import-mapper">
        {headers.map((header, colIndex) => (
          <div className="import-mapper-col" key={colIndex}>
            <div className="import-mapper-header">{header}</div>
            <select
              value={mapping[colIndex] ?? IGNORE_KEY}
              onChange={(e) => onMappingChange(colIndex, e.target.value)}
            >
              <option value={IGNORE_KEY}>Ignore this column</option>
              {TARGET_FIELDS.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                  {f.required ? ' (required)' : ''}
                </option>
              ))}
            </select>
            <div className="import-mapper-samples">
              {sampleRows.map((row, i) => (
                <div key={i} className="import-mapper-sample">
                  {String(row[colIndex] ?? '').trim() || '—'}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {missingRequired.length > 0 && (
        <p className="import-error">
          <AlertTriangle width={14} height={14} /> Still needs a column: {missingRequired.map((f) => f.label).join(', ')}
        </p>
      )}
      {duplicateFields.length > 0 && (
        <p className="import-error">
          <AlertTriangle width={14} height={14} /> Mapped to more than one column: {duplicateFields.map(([k]) => TARGET_FIELDS.find((f) => f.key === k)?.label ?? k).join(', ')}
        </p>
      )}

      <button
        className="btn-terracotta btn-inline"
        disabled={missingRequired.length > 0 || duplicateFields.length > 0}
        onClick={onContinue}
      >
        Continue to Preview
      </button>
    </div>
  )
}

function StatusBadge({ status }) {
  if (status === 'error') return <span className="import-status-badge status-error">Blocked</span>
  if (status === 'warning') return <span className="import-status-badge status-warning">Needs review</span>
  return <span className="import-status-badge status-ready">Ready</span>
}

function PreviewStep({ rows, onBack }) {
  const counts = useMemo(() => {
    const c = { ready: 0, warning: 0, error: 0 }
    rows.forEach((r) => c[r.status]++)
    return c
  }, [rows])

  const visibleRows = rows.slice(0, MAX_PREVIEW_ROWS)

  return (
    <div className="brief-card">
      <div className="import-summary">
        <div className="import-summary-item">
          <span className="import-summary-num">{rows.length}</span>
          <span className="import-summary-label">rows read</span>
        </div>
        <div className="import-summary-item">
          <span className="import-summary-num tone-green">{counts.ready}</span>
          <span className="import-summary-label">ready</span>
        </div>
        <div className="import-summary-item">
          <span className="import-summary-num tone-amber">{counts.warning}</span>
          <span className="import-summary-label">need review</span>
        </div>
        <div className="import-summary-item">
          <span className="import-summary-num tone-red">{counts.error}</span>
          <span className="import-summary-label">blocked</span>
        </div>
      </div>

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
              <th>Status</th>
              <th>Client</th>
              <th>Invoice #</th>
              <th>Due Date</th>
              <th className="ta-right">Amount</th>
              <th>Issues</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, i) => (
              <tr key={i} className={`import-row-${row.status}`}>
                <td><StatusBadge status={row.status} /></td>
                <td>{row.values.client_name || <span className="cell-muted">—</span>}</td>
                <td className="cell-muted">{row.values.invoice_number || '—'}</td>
                <td className="cell-muted">
                  {row.values.due_date ? formatShortDate(row.values.due_date) : '—'}
                </td>
                <td className="ta-right cell-amount">
                  {row.values.amount != null ? formatMoney(row.values.amount) : '—'}
                </td>
                <td className="import-issues">
                  {[...row.errors, ...row.warnings].map((msg, j) => (
                    <div key={j} className={row.errors.includes(msg) ? 'import-issue error' : 'import-issue warning'}>
                      {msg}
                    </div>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > MAX_PREVIEW_ROWS && (
        <p className="import-help">
          Showing the first {MAX_PREVIEW_ROWS} of {rows.length} rows. All {rows.length} are included in the counts above.
        </p>
      )}

      <div className="import-preview-footer">
        <button className="btn-outline btn-inline" onClick={onBack}>
          <ArrowLeft width={16} height={16} /> Back to Mapping
        </button>
        <div className="import-disabled-cta">
          <button className="btn-terracotta btn-inline" disabled>
            Import {counts.ready} Ready Invoices
          </button>
          <p className="import-disabled-reason">{IMPORT_DISABLED_REASON}</p>
        </div>
      </div>
    </div>
  )
}

export default function Import() {
  const [step, setStep] = useState('upload')
  const [busy, setBusy] = useState(false)
  const [uploadError, setUploadError] = useState('')
  const [fileName, setFileName] = useState('')
  const [sheets, setSheets] = useState([])
  const [sheetIndex, setSheetIndex] = useState(0)
  const [hasHeaderRow, setHasHeaderRow] = useState(true)
  const [mapping, setMapping] = useState({})

  const activeSheet = sheets[sheetIndex] ?? null

  const { headers, dataRows } = useMemo(() => {
    if (!activeSheet) return { headers: [], dataRows: [] }
    if (hasHeaderRow) {
      return { headers: activeSheet.rows[0] ?? [], dataRows: activeSheet.rows.slice(1) }
    }
    const colCount = activeSheet.rows[0]?.length ?? 0
    return {
      headers: Array.from({ length: colCount }, (_, i) => `Column ${i + 1}`),
      dataRows: activeSheet.rows,
    }
  }, [activeSheet, hasHeaderRow])

  async function handleFile(file) {
    setUploadError('')
    setBusy(true)
    try {
      const { sheets: parsedSheets } = await parseImportFile(file)
      if (parsedSheets.length === 0) {
        setUploadError('No data found in that file.')
        setBusy(false)
        return
      }
      setFileName(file.name)
      setSheets(parsedSheets)
      setSheetIndex(0)
      const initialHeaders = parsedSheets[0].rows[0] ?? []
      setMapping(guessMapping(initialHeaders))
      setHasHeaderRow(true)
      setStep(parsedSheets.length > 1 ? 'sheet' : 'map')
    } catch (err) {
      setUploadError(err.message || 'Could not read that file.')
    } finally {
      setBusy(false)
    }
  }

  function handleMappingChange(colIndex, fieldKey) {
    setMapping((cur) => {
      const next = { ...cur }
      if (fieldKey === IGNORE_KEY) delete next[colIndex]
      else next[colIndex] = fieldKey
      return next
    })
  }

  const previewRows = useMemo(() => {
    if (step !== 'preview') return []
    const normalized = dataRows.map((row) => normalizeRow(row, mapping))
    return flagDuplicateInvoiceNumbers(normalized)
  }, [step, dataRows, mapping])

  function reset() {
    setStep('upload')
    setUploadError('')
    setFileName('')
    setSheets([])
    setSheetIndex(0)
    setMapping({})
  }

  return (
    <div className="brief">
      <div className="list-head">
        <div>
          <h1 className="brief-greeting">Invoices</h1>
          <h2 className="import-title">Import from CSV or Excel</h2>
        </div>
        <Link to="/invoices" className="btn-outline btn-inline import-cancel-link">
          <X width={16} height={16} /> Cancel
        </Link>
      </div>

      <StepDots step={step} sheetCount={sheets.length} />

      {fileName && step !== 'upload' && (
        <p className="import-filename">
          <FileSpreadsheet width={14} height={14} /> {fileName}
          <button className="import-restart" onClick={reset}>Start over</button>
        </p>
      )}

      {step === 'upload' && (
        <UploadStep onFile={handleFile} error={uploadError} busy={busy} />
      )}

      {step === 'sheet' && (
        <SheetStep
          sheets={sheets}
          selectedIndex={sheetIndex}
          onSelect={(i) => {
            setSheetIndex(i)
            setMapping(guessMapping(sheets[i].rows[0] ?? []))
          }}
          onContinue={() => setStep('map')}
        />
      )}

      {step === 'map' && (
        <MapStep
          headers={headers}
          sampleRows={dataRows.slice(0, 3)}
          mapping={mapping}
          onMappingChange={handleMappingChange}
          hasHeaderRow={hasHeaderRow}
          onToggleHeaderRow={setHasHeaderRow}
          onContinue={() => setStep('preview')}
        />
      )}

      {step === 'preview' && (
        <PreviewStep rows={previewRows} onBack={() => setStep('map')} />
      )}
    </div>
  )
}
