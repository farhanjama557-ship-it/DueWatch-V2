// Test-only helpers for building File-like fixtures. Uses Node's built-in
// global File (Node 20+) — no extra dependency.
import ExcelJS from 'exceljs'

export function csvFile(content, name = 'test.csv') {
  return new File([content], name, { type: 'text/csv' })
}

export function bytesFile(bytes, name) {
  return new File([bytes], name)
}

export async function xlsxFile(buildFn, name = 'test.xlsx') {
  const wb = new ExcelJS.Workbook()
  await buildFn(wb, ExcelJS)
  const buf = await wb.xlsx.writeBuffer()
  return new File([buf], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}
