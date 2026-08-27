import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..')
const migrationPath = path.join(repo, 'supabase/migrations/20260827173500_ask_dw_conversation_persistence.sql')
const persistencePath = path.join(repo, 'src/lib/dwIntelligence/askDwConversationPersistence.js')
const durableRuntimePath = path.join(repo, 'src/lib/dwIntelligence/askDwDurableConversationRuntime.js')

const read = (file) => fs.readFileSync(file, 'utf8')

test('M2C migration creates one tenant-scoped durable conversation table with owner-only RLS reads', () => {
  const sql = read(migrationPath)
  assert.match(sql, /create table if not exists public\.ask_dw_conversations/i)
  assert.match(sql, /user_id uuid not null references auth\.users\(id\) on delete cascade/i)
  assert.match(sql, /primary key \(user_id, conversation_id\)/i)
  assert.match(sql, /alter table public\.ask_dw_conversations enable row level security/i)
  assert.match(sql, /create policy "ask_dw_conversations_select_own"/i)
  assert.match(sql, /\(select auth\.uid\(\)\) = user_id/i)
})

test('M2C table is browser read-only; authenticated writes cross guarded RPC only', () => {
  const sql = read(migrationPath)
  assert.match(sql, /revoke all privileges on public\.ask_dw_conversations\s+from PUBLIC, anon, authenticated, service_role;/i)
  assert.match(sql, /grant select on public\.ask_dw_conversations to authenticated;/i)
  assert.match(sql, /create or replace function public\.persist_ask_dw_conversation_state/i)
  assert.match(sql, /language plpgsql\s+security definer/i)
  assert.match(sql, /v_user_id := \(select auth\.uid\(\)\)/i)
  assert.match(sql, /grant execute on function public\.persist_ask_dw_conversation_state\(text, integer, jsonb\)\s+to authenticated;/i)
})

test('M2C SQL enforces optimistic compare-and-swap plus idempotent network replay', () => {
  const sql = read(migrationPath)
  assert.match(sql, /p_expected_version integer/i)
  assert.match(sql, /for update;/i)
  assert.match(sql, /v_current\.state_version <> p_expected_version/i)
  assert.match(sql, /errcode = '40001'/i)
  assert.match(sql, /ASK_DW_CONVERSATION_STALE/i)
  assert.match(sql, /IDEMPOTENT_REPLAY/i)
  assert.match(sql, /v_current\.state = p_state/i)
})

test('M2C SQL recursively rejects canonical/live/authority keys and locks boundary flags', () => {
  const sql = read(migrationPath)
  assert.match(sql, /assert_ask_dw_case_state_safe/i)
  for (const forbidden of [
    'amount',
    'balance',
    'currency',
    'authority',
    'authorized',
    'permissions',
    'tool_output',
    'financialexecutionauthorized',
    'canonicalmutationauthorized',
    'writesperformed',
  ]) {
    assert.match(sql, new RegExp(`'${forbidden}'`, 'i'))
  }
  assert.match(sql, /ASK_DW_EXECUTION_AUTHORITY_NOT_PERSISTABLE/i)
  assert.match(sql, /canonicalFinancialTruthStored/i)
  assert.match(sql, /rawToolOutputsStored/i)
  assert.match(sql, /businessAuthorityStored/i)
  assert.match(sql, /freshStateRequiredBeforeExecution/i)
  assert.match(sql, /authorityRecheckRequiredBeforeExecution/i)
})

test('M2C SQL makes expiry immutable and rejects non-idempotent updates after expiry', () => {
  const sql = read(migrationPath)
  assert.match(sql, /ASK_DW_CONVERSATION_EXPIRED/i)
  assert.match(sql, /v_current\.expires_at <= clock_timestamp\(\)/i)
  assert.match(sql, /v_expires_at is distinct from v_current\.expires_at/i)
  assert.match(sql, /ASK_DW_CONVERSATION_EXPIRY_CHANGED/i)
  assert.match(sql, /ASK_DW_CONVERSATION_CREATED_AT_CHANGED/i)
})

test('M2C persistence migration contains no canonical invoice/payment mutation or send path', () => {
  const sql = read(migrationPath)
  assert.doesNotMatch(sql, /insert\s+into\s+public\.invoices/i)
  assert.doesNotMatch(sql, /update\s+public\.invoices/i)
  assert.doesNotMatch(sql, /insert\s+into\s+public\.payments/i)
  assert.doesNotMatch(sql, /update\s+public\.payments/i)
  assert.doesNotMatch(sql, /send[_a-z]*email/i)
  assert.doesNotMatch(sql, /resend/i)
})

test('browser persistence adapter writes only through RPC and imports no provider/execution capability', () => {
  const source = read(persistencePath)
  assert.match(source, /\.rpc\(PERSIST_RPC/)
  assert.doesNotMatch(source, /\.insert\s*\(/)
  assert.doesNotMatch(source, /\.update\s*\(/)
  assert.doesNotMatch(source, /\.upsert\s*\(/)
  assert.doesNotMatch(source, /\.delete\s*\(/)
  assert.doesNotMatch(source, /OPENAI_API_KEY|GROQ_API_KEY|RESEND_API_KEY/)
  assert.doesNotMatch(source, /sendEmail|executeAutoSend|recordInvoicePayment/)
})

test('durable runtime persists only result.caseState and keeps fresh runtime work outside storage', () => {
  const source = read(durableRuntimePath)
  assert.match(source, /state: result\.caseState/)
  assert.match(source, /freshLiveReadStillRequired: true/)
  assert.match(source, /authorityRecheckStillRequired: true/)
  assert.match(source, /storesTranscript: false/)
  assert.doesNotMatch(source, /state:\s*result\.askDw/)
  assert.doesNotMatch(source, /state:\s*result\.truthLock/)
  assert.doesNotMatch(source, /state:\s*result\.liveReadReceipt/)
})
