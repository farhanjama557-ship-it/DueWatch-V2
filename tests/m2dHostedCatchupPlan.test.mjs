import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  M2D_AUTHORITATIVE_MIGRATIONS,
  M2D_BASELINE_RECONCILIATION,
  M2D_EDGE_FUNCTION_FILES,
  M2D_EXCLUDED_MIGRATIONS,
  verifyM2dHostedCatchupPlan,
} from '../scripts/system-brain/m2d-hosted-catchup-plan.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

test('M2D catch-up plan hash-locks every authoritative replay source', async () => {
  const verified = await verifyM2dHostedCatchupPlan()
  assert.equal(verified.hosted_write_performed, false)
  assert.equal(
    verified.verified_sources.length,
    M2D_AUTHORITATIVE_MIGRATIONS.length + M2D_EDGE_FUNCTION_FILES.length,
  )
  assert.deepEqual(
    verified.authoritative_migrations,
    M2D_AUTHORITATIVE_MIGRATIONS.map(([name]) => name),
  )
})

test('M2D explicitly excludes the local-only DW live-transition proof migration', () => {
  assert.deepEqual(M2D_EXCLUDED_MIGRATIONS, [
    'supabase/migrations/20260825003000_dw_intelligence_live_transitions_phase2b.sql',
  ])
  const text = fs.readFileSync(path.join(repoRoot, M2D_EXCLUDED_MIGRATIONS[0]), 'utf8')
  assert.match(text, /do not apply to a paid\/cloud environment/i)
})

test('M2D baseline reconciliation does not invent financial truth or perform tenant DML', () => {
  const sql = fs.readFileSync(path.join(repoRoot, M2D_BASELINE_RECONCILIATION), 'utf8')
  assert.match(sql, /add column if not exists phone text/i)
  assert.match(sql, /add column if not exists company text/i)
  assert.match(sql, /add column if not exists notes text/i)
  assert.match(sql, /alter column due_date drop not null/i)
  assert.match(sql, /alter column client_id drop not null/i)
  assert.match(sql, /last_reminder type timestamptz/i)
  assert.match(sql, /at time zone 'UTC'/i)
  assert.doesNotMatch(sql, /default\s+'USD'/i)
  assert.doesNotMatch(sql, /\btruncate\b/i)
  assert.doesNotMatch(sql, /\bdrop\s+table\b/i)
  assert.doesNotMatch(sql, /\bupdate\s+public\.(clients|invoices)\b/i)
  assert.doesNotMatch(sql, /\bdelete\s+from\s+public\.(clients|invoices)\b/i)
  assert.doesNotMatch(sql, /\binsert\s+into\s+public\.(clients|invoices)\b/i)
})

test('M2D baseline drops only the verified legacy same-name uniqueness constraint', () => {
  const sql = fs.readFileSync(path.join(repoRoot, M2D_BASELINE_RECONCILIATION), 'utf8')
  assert.match(sql, /clients_user_id_name_key:UNIQUE \(user_id, name\)/)
  assert.match(sql, /drop constraint if exists clients_user_id_name_key/i)
  assert.match(sql, /multiple UNIQUE\(user_id,name\) constraints/i)
})

test('M2D Edge Function deployment contract is closed-world and JWT-required', async () => {
  const verified = await verifyM2dHostedCatchupPlan()
  assert.equal(verified.edge_function.slug, 'ask-dw-model')
  assert.equal(verified.edge_function.verify_jwt_required, true)
  assert.deepEqual(
    verified.edge_function.files,
    M2D_EDGE_FUNCTION_FILES.map(([name]) => name),
  )
})
