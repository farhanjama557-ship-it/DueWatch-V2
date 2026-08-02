import { ArrowLeft, FileSpreadsheet } from 'lucide-react'
import { describeSheet } from '../../lib/importUiAdapter.js'

export default function SheetStep({ sheets, selectedIndex, onSelect, onContinue, onBack }) {
  return (
    <div className="brief-card">
      <p className="import-help">This file has multiple sheets. Every sheet with data is shown below — choose the one to preview.</p>
      <fieldset className="import-sheet-list">
        <legend className="sr-only">Choose a worksheet</legend>
        {sheets.map((s, i) => {
          const desc = describeSheet(s)
          return (
            <label key={s.name} className={i === selectedIndex ? 'import-sheet-option selected' : 'import-sheet-option'}>
              <input type="radio" name="sheet" checked={i === selectedIndex} onChange={() => onSelect(i)} />
              <FileSpreadsheet width={16} height={16} aria-hidden="true" />
              <span className="import-sheet-name">{desc.name}</span>
              <span className="import-sheet-meta">
                {desc.rowCount} row{desc.rowCount === 1 ? '' : 's'} · {desc.columnCount} column{desc.columnCount === 1 ? '' : 's'}
              </span>
            </label>
          )
        })}
      </fieldset>
      <div className="import-preview-footer">
        <button className="btn-outline btn-inline import-btn-back" onClick={onBack}>
          <ArrowLeft width={16} height={16} aria-hidden="true" /> Back
        </button>
        <button className="btn-terracotta btn-inline" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  )
}
