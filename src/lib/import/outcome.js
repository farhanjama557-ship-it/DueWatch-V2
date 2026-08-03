// Derives a preview outcome purely from the structured `blocksImport` /
// `requiresUserChoice` flags on a set of issues — never from UI strings,
// severity labels, or issue counts by themselves. Every issue-producing
// module in this engine is responsible for setting those two flags
// correctly for its own codes; this function only combines them.
//
// Rule:
//   - no blocking issues, but some (nonblocking) issues exist -> ready_with_warnings
//   - no issues at all                                        -> ready
//   - a blocking issue exists that also requires a user choice -> review_required
//     (the row/file is structurally fine but can't proceed until a human
//     resolves an ambiguity or duplicate)
//   - a blocking issue exists that does NOT require a user choice -> rejected
//     (the row/file cannot safely proceed as supplied, full stop)
export const OUTCOMES = Object.freeze({
  READY: 'ready',
  READY_WITH_WARNINGS: 'ready_with_warnings',
  REVIEW_REQUIRED: 'review_required',
  REJECTED: 'rejected',
})

export function computeOutcome(issues = []) {
  const blocking = issues.filter((i) => i.blocksImport)
  if (blocking.length === 0) {
    return issues.length > 0 ? OUTCOMES.READY_WITH_WARNINGS : OUTCOMES.READY
  }
  const needsChoice = blocking.some((i) => i.requiresUserChoice)
  return needsChoice ? OUTCOMES.REVIEW_REQUIRED : OUTCOMES.REJECTED
}

export function summarizeOutcomes(rowResults) {
  const summary = { ready: 0, ready_with_warnings: 0, review_required: 0, rejected: 0, total: rowResults.length }
  for (const row of rowResults) {
    summary[row.outcome] = (summary[row.outcome] || 0) + 1
  }
  return summary
}
