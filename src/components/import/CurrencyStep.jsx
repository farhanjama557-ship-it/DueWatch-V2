import { SUPPORTED_CURRENCIES } from '../../lib/import/money.js'
import { rowsWithIssueCode, clientIdentityLabel } from '../../lib/importUiCopy.js'

const SAMPLE_COUNT = 5

export default function CurrencyStep({ rows, selectedCurrency, onSelect, onConfirm }) {
  const affected = rowsWithIssueCode(rows, 'CURRENCY_DECISION_REQUIRED')
  const sample = affected.slice(0, SAMPLE_COUNT)

  return (
    <div className="brief-card">
      <p className="import-help">
        {affected.length} row{affected.length === 1 ? '' : 's'} had no currency in the file. Choose the currency
        those rows should use. Rows that already had an explicit currency are unchanged.
      </p>

      <fieldset className="import-currency-choice">
        <legend className="sr-only">Default currency</legend>
        {SUPPORTED_CURRENCIES.map((code) => (
          <label key={code} className="import-header-toggle">
            <input type="radio" name="default-currency" checked={selectedCurrency === code} onChange={() => onSelect(code)} />
            {code}
          </label>
        ))}
      </fieldset>

      {sample.length > 0 && (
        <div className="list-card import-preview-table-wrap">
          <table className="invoice-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Invoice #</th>
              </tr>
            </thead>
            <tbody>
              {sample.map((row) => (
                <tr key={row.originalRowNumber}>
                  <td>{clientIdentityLabel(row.normalized)}</td>
                  <td className="cell-muted">{row.normalized.invoice_number || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <button className="btn-terracotta btn-inline" onClick={() => onConfirm(selectedCurrency)}>
        Confirm {selectedCurrency}
      </button>
    </div>
  )
}
