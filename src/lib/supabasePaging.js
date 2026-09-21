export const DEFAULT_PAGE_SIZE = 500
export const DEFAULT_MAX_PAGES = 200

export async function fetchAllPages(
  makeQuery,
  { pageSize = DEFAULT_PAGE_SIZE, maxPages = DEFAULT_MAX_PAGES } = {}
) {
  if (typeof makeQuery !== 'function') {
    throw new Error('Paged read requires a query factory.')
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) {
    throw new Error('Paged read size must be between 1 and 1000.')
  }

  const rows = []
  for (let page = 0; page < maxPages; page += 1) {
    const from = page * pageSize
    const to = from + pageSize - 1
    const result = await makeQuery(from, to)
    if (result?.error) {
      return { data: null, error: result.error, complete: false }
    }

    const pageRows = Array.isArray(result?.data) ? result.data : []
    rows.push(...pageRows)
    if (pageRows.length < pageSize) {
      return { data: rows, error: null, complete: true }
    }
  }

  return {
    data: null,
    error: new Error('Paged read exceeded the configured completeness limit.'),
    complete: false,
  }
}
