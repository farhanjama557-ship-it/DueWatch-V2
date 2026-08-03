import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveClientForInvoice } from '../src/lib/clients.js'

test('invoice creation uses the database client-resolution RPC', async () => {
  const calls = []
  const supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      return { data: 'client-uuid', error: null }
    },
  }
  const result = await resolveClientForInvoice({
    supabase,
    userId: 'user-uuid',
    name: 'Northbend Studio',
  })
  assert.equal(result, 'client-uuid')
  assert.deepEqual(calls, [{
    name: 'resolve_or_create_client',
    args: { p_user_id: 'user-uuid', p_name: 'Northbend Studio' },
  }])
})

test('client-resolution errors fail closed before invoice insertion', async () => {
  const expected = new Error('Ambiguous client identity')
  const supabase = {
    rpc: async () => ({ data: null, error: expected }),
  }
  await assert.rejects(
    resolveClientForInvoice({ supabase, userId: 'u', name: 'Acme' }),
    expected,
  )
})

test('client resolution forwards the requested tenant without cross-tenant reuse', async () => {
  const calls = []
  const idsByTenant = new Map([
    ['tenant-a', 'aaaaaaaa-0000-4000-8000-000000000001'],
    ['tenant-b', 'bbbbbbbb-0000-4000-8000-000000000002'],
  ])
  const supabase = {
    rpc: async (name, args) => {
      calls.push({ name, args })
      return { data: idsByTenant.get(args.p_user_id), error: null }
    },
  }

  const clientA = await resolveClientForInvoice({
    supabase,
    userId: 'tenant-a',
    name: 'Shared Client',
  })
  const clientB = await resolveClientForInvoice({
    supabase,
    userId: 'tenant-b',
    name: 'Shared Client',
  })

  assert.equal(clientA, 'aaaaaaaa-0000-4000-8000-000000000001')
  assert.equal(clientB, 'bbbbbbbb-0000-4000-8000-000000000002')
  assert.notEqual(clientA, clientB)
  assert.deepEqual(calls.map(({ args }) => args.p_user_id), ['tenant-a', 'tenant-b'])
})

test('current resolver wrapper returns only the canonical client UUID value', async () => {
  const canonicalId = 'cccccccc-0000-4000-8000-000000000003'
  const supabase = {
    rpc: async () => ({ data: canonicalId, error: null }),
  }
  const result = await resolveClientForInvoice({
    supabase,
    userId: 'tenant-a',
    name: 'Northbend Studio',
  })

  assert.equal(result, canonicalId)
  assert.equal(typeof result, 'string')
})
