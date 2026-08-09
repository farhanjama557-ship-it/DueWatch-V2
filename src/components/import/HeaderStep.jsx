import { ArrowLeft } from 'lucide-react'

const RAW_PREVIEW_ROWS = 3
const RAW_PREVIEW_COL_WIDTH = 160

// Local, display-only cell unwrapping — identical in spirit to the
// adapter's internal displayCellValue, but this component needs it before
// a header decision exists (i.e. before buildSheetView can even run), so
// it reads the raw parsed sheet directly rather than through the adapter.
function cellText(cell) {
  if (!cell || cell.raw == null) return ''
  if (cell.raw instanceof Date) return cell.raw.toISOString()
  return String(cell.raw)
}

export default function HeaderStep({ sheet, hasHeaderRow, onChoose, onContinue, onBack }) {
  const previewRows = sheet.rows.slice(0, RAW_PREVIEW_ROWS)
  const columnCount = previewRows.reduce((max, r) => Math.max(max, r.cells.length), 0)

  return (
    <div className="brief-card">
      <fieldset className="import-fieldset-reset">
        <legend className="import-help">Does the first row contain column headers?</legend>
        <div className="import-choice-list">
          <label className={hasHeaderRow === true ? 'import-choice-row selected' : 'import-choice-row'}>
            <input type="radio" name="header-choice" checked={hasHeaderRow === true} onChange={() => onChoose(true)} />
            First row contains column headers
          </label>
          <label className={hasHeaderRow === false ? 'import-choice-row selected' : 'import-choice-row'}>
            <input type="radio" name="header-choice" checked={hasHeaderRow === false} onChange={() => onChoose(false)} />
            This file has no header row
          </label>
        </div>
      </fieldset>

      <p className="import-well-label">Raw preview of the first {previewRows.length} rows</p>
      <div className="import-data-well import-preview-table-wrap">
        <table
          className="invoice-table import-raw-preview-table"
          /* table-layout:fixed only honors each <col>'s width as a literal
             pixel size when the table's own width is an explicit length —
             left at width:auto (even with fixed layout) Chromium instead
             shrinks the whole table to its container and treats the col
             widths as relative proportions, which is what let a 13+ column
             file compress every column below its own text's width. Setting
             the table's width to the exact sum of its columns makes each
             <col>'s width literal, and lets the table grow past its
             wrapper so the wrapper's existing overflow-x:auto scrolls it. */
          style={{ width: columnCount * RAW_PREVIEW_COL_WIDTH }}
        >
          <colgroup>
            {Array.from({ length: columnCount }, (_, i) => (
              <col key={i} />
            ))}
          </colgroup>
          <tbody>
            {previewRows.map((row) => (
              <tr key={row.rowNumber}>
                {Array.from({ length: columnCount }, (_, i) => {
                  const text = cellText(row.cells[i])
                  return (
                    <td key={i} title={text || undefined}>
                      {text || <span className="cell-muted">—</span>}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="import-scroll-hint">Scroll horizontally to see every column.</p>

      <div className="import-preview-footer">
        <button className="btn-outline btn-inline import-btn-back" onClick={onBack}>
          <ArrowLeft width={16} height={16} aria-hidden="true" /> Back
        </button>
        <button className="btn-terracotta btn-inline" onClick={onContinue} disabled={hasHeaderRow == null}>
          Continue to Mapping
        </button>
      </div>
    </div>
  )
}
