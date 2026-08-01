// Builds SheetRow/ParsedCell structures directly (bypassing parse.js) for
// unit-testing normalize.js against hand-crafted rows, including formula
// cells that would otherwise require a real ExcelJS round-trip.
export function cell(raw, opts = {}) {
  return { raw: raw === undefined ? null : raw, isFormula: false, formula: null, hasCachedValue: true, ...opts }
}

export function formulaCell(formula, result) {
  return { raw: result === undefined ? null : result, isFormula: true, formula, hasCachedValue: result !== undefined }
}

export function row(rowNumber, cells) {
  return { rowNumber, cells: cells.map((c) => (c && typeof c === 'object' && 'isFormula' in c ? c : cell(c))) }
}

export function sheet(name, rows) {
  return { name, rows }
}
