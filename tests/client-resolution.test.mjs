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
