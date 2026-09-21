import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const sql=await readFile(new URL('../supabase/migrations/20260921131500_workspace_preferences.sql',import.meta.url),'utf8')
const service=await readFile(new URL('../src/lib/workspacePreferences.js',import.meta.url),'utf8')
const autopilot=await readFile(new URL('../src/lib/autopilot.js',import.meta.url),'utf8')
const pages=await readFile(new URL('../src/overhaul/OverhaulPages.jsx',import.meta.url),'utf8')

test('workspace preferences are tenant-owned and RLS protected',()=>{
  assert.match(sql,/alter table public\.workspace_preferences enable row level security/i)
  assert.match(sql,/for select to authenticated[\s\S]*auth\.uid\(\)[\s\S]*user_id/i)
  assert.match(sql,/for insert to authenticated[\s\S]*with check[\s\S]*auth\.uid\(\)[\s\S]*user_id/i)
  assert.match(sql,/for update to authenticated[\s\S]*using[\s\S]*with check/i)
  assert.match(sql,/revoke all on public\.workspace_preferences from public, anon, authenticated/i)
})

test('workspace preferences contain presentation and notification state, not execution authority',()=>{
  assert.match(sql,/workspace_name text/)
  assert.match(sql,/timezone text/)
  assert.match(sql,/promise_notifications boolean/)
  assert.doesNotMatch(sql,/approval_required/)
  assert.doesNotMatch(sql,/autopilot_enabled/)
  assert.doesNotMatch(sql,/value_limit/)
})

test('settings save through persisted preference service and Autopilot approval stays in authority service',()=>{
  assert.match(service,/\.from\('workspace_preferences'\)/)
  assert.match(service,/\.upsert\(payload/)
  assert.match(autopilot,/setAutopilotApprovalRequired/)
  assert.match(autopilot,/\.from\('autopilot_settings'\)/)
  assert.match(pages,/saveWorkspacePreferences/)
  assert.match(pages,/setAutopilotApprovalRequired/)
})

test('browser timezone is disclosed as unsaved until persisted',()=>{
  assert.match(pages,/browser timezone is only used as an unsaved starting value/i)
})
