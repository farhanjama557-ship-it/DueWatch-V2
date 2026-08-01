const RAW_PREVIEW_ROWS = 3

// Local, display-only cell unwrapping — identical in spirit to the
// adapter's internal displayCellValue, but this component needs it before
// a header decision exists (i.e. before buildSheetView can even run), so
// it reads the raw parsed sheet directly rather than through the adapter.
function cellText(cell) {
  if (!cell || cell.raw == null) return ''
  if (cell.raw instanceof Date) return cell.raw.toISOString()
  return String(cell.raw)
}

export default function HeaderStep({ sheet, hasHeaderRow, onChoose, onContinue }) {
  const previewRows = sheet.rows.slice(0, RAW_PREVIEW_ROWS)
  const columnCount = previewRows.reduce((max, r) => Math.max(max, r.cells.length), 0)

  return (
    <div className="brief-card">
      <fieldset className="import-header-choice">
        <legend className="import-help">Does the first row contain column headers?</legend>
        <label className="import-header-toggle">
          <input type="radio" name="header-choice" checked={hasHeaderRow === true} onChange={() => onChoose(true)} />
          First row contains column headers
        </label>
        <label className="import-header-toggle">
          <input type="radio" name="header-choice" checked={hasHeaderRow === false} onChange={() => onChoose(false)} />
          This file has no header row
        </label>
      </fieldset>

      <p className="import-help">Raw preview of the first {previewRows.length} rows:</p>
      <div className="list-card import-preview-table-wrap">
        <table className="invoice-table import-raw-preview-table">
          <tbody>
            {previewRows.map((row) => (
              <tr key={row.rowNumber}>
                {Array.from({ length: columnCount }, (_, i) => (
                  <td key={i}>{cellText(row.cells[i]) || <span className="cell-muted">—</span>}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <button className="btn-terracotta btn-inline" onClick={onContinue} disabled={hasHeaderRow == null}>
        Continue to Mapping
      </button>
    </div>
  )
}
