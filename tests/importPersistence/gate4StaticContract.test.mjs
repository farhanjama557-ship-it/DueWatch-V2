import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const clientSource = await readFile(new URL('../../src/lib/importPersistence/importPersistenceClient.js', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../../src/App.jsx', import.meta.url), 'utf8')
const detailSource = await readFile(new URL('../../src/pages/ImportRunDetail.jsx', import.meta.url), 'utf8')
const progressSource = await readFile(new URL('../../src/lib/importPersistence/importProgress.js', import.meta.url), 'utf8')

test('history and detail reads explicitly scope browser queries to the signed-in user', () => {
  assert.match(clientSource, /listImportRuns[\s\S]*?\.eq\('user_id', userId\)/)
  assert.match(clientSource, /getImportRunDetail[\s\S]*?\.eq\('user_id', userId\)/)
  assert.match(clientSource, /selectAllForRun[\s\S]*?\.eq\('user_id', userId\)/)
  assert.match(progressSource, /getRunProgress[\s\S]*?\.eq\('user_id', userId\)/)
})

test('new and resumed progress polling both thread the authenticated tenant identity', () => {
  assert.match(clientSource, /runImportToCompletion[\s\S]*?getProgress: \(runId\) => getRunProgress\(\{ userId, runId \}\)/)
  assert.match(clientSource, /continueImportRunToCompletion[\s\S]*?getProgress: \(existingRunId\) => getRunProgress\(\{ userId, runId: existingRunId \}\)/)
  assert.match(detailSource, /continueImportRunToCompletion\(\{\s*userId: user\.id,/)
})

test('history is bounded, deterministic, paginated, and accepts an empty result', () => {
  const historyRead = clientSource.slice(clientSource.indexOf('export async function listImportRuns'), clientSource.indexOf('async function selectAllForRun'))
  assert.match(historyRead, /Math\.min\(Math\.max\(pageSize, 1\), 20\)/)
  assert.match(historyRead, /\.order\('created_at', \{ ascending: false \}\)[\s\S]*\.order\('id', \{ ascending: false \}\)/)
  assert.match(historyRead, /\.range\(start, end\)/)
  assert.match(historyRead, /\(data \|\| \[\]\)\.map/)
})

test('read models request no operator-only diagnostic and perform no table writes', () => {
  const readModel = clientSource.slice(clientSource.indexOf('export async function listImportRuns'), clientSource.indexOf('export async function runImportToCompletion'))
  assert.doesNotMatch(readModel, /fields:\s*['"][^'"]*internal_diagnostic/)
  assert.doesNotMatch(readModel, /\.(insert|update|delete|upsert)\(/)
  assert.doesNotMatch(readModel, /service_role/)
})

test('batch failure reads only the existing customer-visible column grant', () => {
  assert.match(clientSource, /fields: 'id, run_id, user_id, batch_index, status, row_count, failure_reason, created_at'/)
  assert.match(detailSource, /lastBatchFailure\.failure_reason/)
})

test('history routes remain lazy and detail recovery continues an existing run only', () => {
  assert.match(appSource, /lazy\(\(\) => import\('\.\/pages\/ImportHistory'\)\)/)
  assert.match(appSource, /lazy\(\(\) => import\('\.\/pages\/ImportRunDetail'\)\)/)
  assert.match(detailSource, /continueImportRunToCompletion/)
  assert.doesNotMatch(detailSource, /startImportRun|start_import_run|buildImportIdempotencyKey/)
})

test('detail status is derived from persisted run status, not event names', () => {
  assert.match(detailSource, /presentRunStatus\(detail\.run\.status\)/)
  assert.doesNotMatch(detailSource, /presentRunStatus\([^)]*event/)
})

test('viewing is read-only while recovery and cancellation require explicit controls', () => {
  assert.doesNotMatch(detailSource, /useEffect\(\(\) => \{\s*(?:void\s+)?(?:continueImportRunToCompletion|requestImportCancellation)/)
  assert.match(detailSource, /onClick=\{handleResume\}/)
  assert.match(detailSource, /onClick=\{handleRequestCancellation\}/)
  assert.match(detailSource, /Finish cancellation/)
})
