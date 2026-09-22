import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  requireStripeChargeMinorUnitExponent,
  stripeChargeMinorUnitExponent,
} from '../src/lib/providerAdapters/payments/stripeCurrencyMinorUnits.js'
import {
  minorUnitsToDecimalString,
} from '../src/lib/integrations/providerMoney.js'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const migrationPath = path.join(repo, 'supabase/migrations/20260921163000_provider_foundation.sql')
const sql = readFileSync(migrationPath, 'utf8')

const TABLES = [
  'provider_connections',
  'provider_oauth_states',
  'provider_webhook_events',
  'provider_objects',
  'provider_object_links',
  'provider_sync_state',
  'provider_reconciliation_exceptions',
]

test('provider phase 1 creates exactly the seven architecture tables', () => {
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`create table public\\.${table}\\s*\\(`, 'i'))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
  }
  const created = [...sql.matchAll(/create table public\.([a-z0-9_]+)\s*\(/gi)]
    .map((match) => match[1])
    .filter((name) => name.startsWith('provider_'))
  assert.deepEqual(created.sort(), [...TABLES].sort())
})

test('OAuth state and raw webhook tables have no authenticated grant', () => {
  assert.doesNotMatch(
    sql,
    /grant\s+(?:all|select|insert|update|delete)[^;]*provider_oauth_states[^;]*to authenticated;/i,
  )
  assert.doesNotMatch(
    sql,
    /grant\s+(?:all|select|insert|update|delete)[^;]*provider_webhook_events[^;]*to authenticated;/i,
  )
  assert.match(sql, /revoke all on table[\s\S]*provider_oauth_states[\s\S]*provider_webhook_events[\s\S]*from public, anon, authenticated;/i)
})

test('browser sees provider connection status through the safe view, not credential refs', () => {
  const viewStart = sql.indexOf('create view public.provider_connection_status')
  const viewEnd = sql.indexOf('revoke all on public.provider_connection_status')
  assert.ok(viewStart >= 0 && viewEnd > viewStart)
  const view = sql.slice(viewStart, viewEnd)
  assert.doesNotMatch(view, /credential_ref|webhook_secret_ref/)
  assert.match(view, /where c\.user_id = \(select auth\.uid\(\)\)/i)
  assert.match(sql, /grant select on public\.provider_connection_status to authenticated;/i)
  assert.doesNotMatch(sql, /grant select on table\s+public\.provider_connections\s+to authenticated/i)
})

test('provider relationships carry tenant identity in composite foreign keys', () => {
  assert.match(sql, /foreign key \(user_id, connection_id\)[\s\S]*references public\.provider_connections\(user_id, id\)/i)
  assert.match(sql, /foreign key \(user_id, provider_object_id\)[\s\S]*references public\.provider_objects\(user_id, id\)/i)
})

test('tenant-explicit payment sibling is service-role only and browser wrapper cannot name a tenant', () => {
  assert.match(sql, /create function duewatch_ops\.record_payment_for_tenant\([\s\S]*p_user_id uuid/i)
  assert.match(sql, /revoke all on function duewatch_ops\.record_payment_for_tenant\([\s\S]*from public, anon, authenticated;/i)
  assert.match(sql, /grant execute on function duewatch_ops\.record_payment_for_tenant\([\s\S]*to service_role;/i)
  assert.match(sql, /create function public\.record_payment\([\s\S]*v_user_id uuid := auth\.uid\(\);/i)
  assert.match(sql, /return duewatch_ops\.record_payment_for_tenant\(\s*v_user_id,/i)
  assert.doesNotMatch(
    sql.match(/create function public\.record_payment\([\s\S]*?\$\$;/i)?.[0] || '',
    /p_user_id\s+uuid/i,
  )
})

test('browser and service-role payment paths share one idempotency body', () => {
  const sibling = sql.match(/create function duewatch_ops\.record_payment_for_tenant\([\s\S]*?\$\$;/i)?.[0] || ''
  const wrapper = sql.match(/create function public\.record_payment\([\s\S]*?\$\$;/i)?.[0] || ''
  assert.match(sibling, /pg_advisory_xact_lock/i)
  assert.match(sibling, /PAYMENT_OPERATION_CONFLICT/)
  assert.match(sibling, /operation_request/)
  assert.match(sibling, /operation_result/)
  assert.doesNotMatch(wrapper, /pg_advisory_xact_lock|PAYMENT_OPERATION_CONFLICT|operation_request/)
})

test('Stripe charge minor-unit exponents are explicit and unknown codes fail closed', () => {
  assert.equal(stripeChargeMinorUnitExponent('JPY'), 0)
  assert.equal(stripeChargeMinorUnitExponent('USD'), 2)
  assert.equal(stripeChargeMinorUnitExponent('BHD'), 3)
  assert.equal(requireStripeChargeMinorUnitExponent('krw'), 0)
  assert.equal(stripeChargeMinorUnitExponent('XTS'), null)
  assert.throws(
    () => requireStripeChargeMinorUnitExponent('XTS'),
    (error) => error?.code === 'PROVIDER_CURRENCY_UNKNOWN',
  )
})

test('Stripe minor-unit conversion preserves JPY and USD amounts exactly', () => {
  assert.equal(
    minorUnitsToDecimalString({ amountMinor: '10000', exponent: requireStripeChargeMinorUnitExponent('JPY') }),
    '10000',
  )
  assert.equal(
    minorUnitsToDecimalString({ amountMinor: '1050', exponent: requireStripeChargeMinorUnitExponent('USD') }),
    '10.50',
  )
})

function walkFiles(root) {
  const out = []
  for (const name of readdirSync(root)) {
    const full = path.join(root, name)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

test('phase 1 provider runtime has no ledger-write call site yet', () => {
  const roots = [
    path.join(repo, 'src/lib/integrations'),
    path.join(repo, 'src/lib/providerAdapters'),
    path.join(repo, 'src/overhaul'),
    path.join(repo, 'supabase/functions'),
  ].filter((root) => {
    try { return statSync(root).isDirectory() } catch { return false }
  })

  const offenders = []
  for (const root of roots) {
    for (const file of walkFiles(root)) {
      if (!/\.(?:js|jsx|ts|tsx|mjs)$/.test(file)) continue
      const source = readFileSync(file, 'utf8')
      if (/record_payment_for_tenant/.test(source)) offenders.push(path.relative(repo, file))
    }
  }
  assert.deepEqual(offenders, [])
})


const providerStatusHardeningPath = path.join(
  repo,
  'supabase/migrations/20260922145500_provider_connection_status_invoker.sql',
)
const providerStatusHardeningSql = readFileSync(providerStatusHardeningPath, 'utf8')

test('provider connection status view is security-invoker and secret columns stay ungranted', () => {
  assert.match(
    providerStatusHardeningSql,
    /alter view public\.provider_connection_status\s+set \(security_invoker = true\);/i,
  )
  assert.match(
    providerStatusHardeningSql,
    /create policy provider_connections_select_own[\s\S]*using \(user_id = \(select auth\.uid\(\)\)\);/i,
  )
  assert.match(
    providerStatusHardeningSql,
    /grant select \([\s\S]*provider_account_id[\s\S]*disconnected_at[\s\S]*\) on public\.provider_connections to authenticated;/i,
  )
  assert.match(
    providerStatusHardeningSql,
    /revoke select \(webhook_secret_ref, credential_ref\)[\s\S]*from authenticated;/i,
  )
  assert.doesNotMatch(
    providerStatusHardeningSql,
    /grant select \([^)]*(?:webhook_secret_ref|credential_ref)[^)]*\) on public\.provider_connections to authenticated;/i,
  )
})
