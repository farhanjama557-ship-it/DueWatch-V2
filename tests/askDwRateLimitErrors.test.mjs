import test from 'node:test'
import assert from 'node:assert/strict'

import { createAskDwLiveModels } from '../src/lib/dwIntelligence/askDwLiveModelProvider.js'

function makeSupabaseWithInvokeResult(result) {
  return {
    functions: {
      async invoke() {
        return result
      },
    },
  }
}

test('Ask DW surfaces Groq free-tier 429 with a useful retry message', async () => {
  const context = new Response(JSON.stringify({
    error: 'Ask DW free model quota is temporarily exhausted. Try again after the limit resets.',
    code: 'GROQ_RATE_LIMITED',
    retryAfterSeconds: 17,
  }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  })

  const supabase = makeSupabaseWithInvokeResult({
    data: null,
    error: {
      message: 'Edge Function returned a non-2xx status code',
      context,
    },
  })

  const { verifierModel } = createAskDwLiveModels({ supabase })

  await assert.rejects(
    () => verifierModel.verify({ hello: 'world' }),
    (error) => {
      assert.equal(error.code, 'GROQ_RATE_LIMITED')
      assert.equal(error.retryAfterSeconds, 17)
      assert.match(error.message, /free model quota is temporarily exhausted/i)
      assert.match(error.message, /17 seconds/i)
      assert.doesNotMatch(error.message, /non-2xx/i)
      return true
    },
  )
})

test('Ask DW preserves the Edge Function body for other typed HTTP errors', async () => {
  const context = new Response(JSON.stringify({
    error: 'Ask DW model input is too large for the free-tier activation profile.',
    code: 'FREE_TIER_INPUT_LIMIT',
  }), {
    status: 413,
    headers: { 'Content-Type': 'application/json' },
  })

  const supabase = makeSupabaseWithInvokeResult({
    data: null,
    error: {
      message: 'Edge Function returned a non-2xx status code',
      context,
    },
  })

  const { primaryModel } = createAskDwLiveModels({ supabase })

  await assert.rejects(
    () => primaryModel.synthesize({ hello: 'world' }),
    (error) => {
      assert.equal(error.code, 'FREE_TIER_INPUT_LIMIT')
      assert.match(error.message, /input is too large/i)
      assert.doesNotMatch(error.message, /non-2xx/i)
      return true
    },
  )
})

test('Ask DW still falls back to the Supabase error message when no JSON response is readable', async () => {
  const supabase = makeSupabaseWithInvokeResult({
    data: null,
    error: {
      message: 'Network bridge failed',
      context: null,
    },
  })

  const { primaryModel } = createAskDwLiveModels({ supabase })

  await assert.rejects(
    () => primaryModel.synthesize({ hello: 'world' }),
    /Network bridge failed/,
  )
})
