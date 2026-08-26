import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.js'
import {
  ASK_DW_OPENAI_ROLE,
  ASK_DW_OPENAI_STAGE,
  assertAskDwOpenAiRequest,
  stageInstructions,
  stageSchema,
} from '../_shared/askDwOpenAiContract.js'

const GROQ_RESPONSES_URL = 'https://api.groq.com/openai/v1/responses'

// Free-tier guardrail: keep individual envelopes small enough that the
// controlled SYNTHESIZE + VERIFY pair has a realistic chance to fit inside
// Groq's current 8K-token-per-minute free limit for GPT-OSS.
const MAX_REQUEST_CHARS = 12_000
const PROVIDER_TIMEOUT_MS = 90_000

// These are the only currently supported models we allow through this
// strict-JSON provider. Both support reasoning + strict JSON schema on Groq.
const ALLOWED_GROQ_MODELS = new Set([
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  try {
    // Fail closed. A configured Groq key alone cannot make a paid/live call.
    if (Deno.env.get('ASK_DW_MODEL_ENABLED') !== 'true') {
      return json({ error: 'Ask DW live model execution is disabled.' }, 503)
    }

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwt) return json({ error: 'Not authenticated' }, 401)

    const admin = createClient(
      Deno.env.get('SUPABASE_URL') || '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
    )
    const { data: { user }, error: userError } = await admin.auth.getUser(jwt)
    if (userError || !user) return json({ error: 'Not authenticated' }, 401)
    if (!isCallerEnabled(user.id)) {
      return json({ error: 'Ask DW live model access is not enabled for this account.' }, 403)
    }

    const body = await req.json()
    const role = String(body?.role || '')
    const stage = String(body?.stage || '').toUpperCase()
    assertAskDwOpenAiRequest({ role, stage })

    const inputEnvelope = {
      contract: body?.contract ?? null,
      input: body?.input ?? null,
    }
    const serializedInput = JSON.stringify(inputEnvelope)
    if (serializedInput.length > MAX_REQUEST_CHARS) {
      return json({
        error: 'Ask DW model input is too large for the free-tier activation profile.',
        code: 'FREE_TIER_INPUT_LIMIT',
      }, 413)
    }

    const apiKey = Deno.env.get('GROQ_API_KEY')
    if (!apiKey) return json({ error: 'Groq provider is not configured.' }, 503)

    const primaryModel = Deno.env.get('GROQ_PRIMARY_MODEL') || 'openai/gpt-oss-120b'
    const verifierModel = Deno.env.get('GROQ_VERIFIER_MODEL') || 'openai/gpt-oss-120b'
    const model = role === ASK_DW_OPENAI_ROLE.VERIFIER ? verifierModel : primaryModel

    if (!ALLOWED_GROQ_MODELS.has(model)) {
      return json({
        error: 'Configured Groq model is outside the controlled Ask DW allowlist.',
        code: 'GROQ_MODEL_NOT_ALLOWED',
      }, 503)
    }

    const effort = 'medium'

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), PROVIDER_TIMEOUT_MS)
    let response
    try {
      response = await fetch(GROQ_RESPONSES_URL, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          store: false,
          reasoning: { effort },
          instructions: stageInstructions(stage),
          input: [
            {
              role: 'user',
              content: [
                {
                  type: 'input_text',
                  text: `Return only the structured JSON required for Ask DW stage ${stage}.\n\n${serializedInput}`,
                },
              ],
            },
          ],
          text: {
            format: {
              type: 'json_schema',
              name: `ask_dw_${stage.toLowerCase()}`,
              strict: true,
              schema: stageSchema(stage),
            },
          },
          // Deliberately much smaller than the old paid-provider ceilings.
          // The controlled activation schemas should fit comfortably inside
          // these bounds and this reduces free-tier token pressure.
          max_output_tokens:
            stage === ASK_DW_OPENAI_STAGE.VERIFY
              ? 1800
              : stage === ASK_DW_OPENAI_STAGE.PLAN
                ? 1600
                : 1600,
        }),
      })
    } catch (error) {
      if (error?.name === 'AbortError') return json({ error: 'Ask DW model provider timed out.' }, 504)
      return json({ error: 'Ask DW model provider could not be reached.' }, 502)
    } finally {
      clearTimeout(timeout)
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      return json({ error: 'Ask DW model provider returned an unreadable response.' }, 502)
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      return json({
        error: 'Ask DW free model quota is temporarily exhausted. Try again after the limit resets.',
        code: 'GROQ_RATE_LIMITED',
        retryAfterSeconds: retryAfter ? Number(retryAfter) || null : null,
      }, 429, retryAfter ? { 'Retry-After': retryAfter } : {})
    }

    if (!response.ok) {
      console.error('Ask DW Groq request failed', response.status, payload?.error?.code || 'unknown')
      return json({ error: 'Ask DW model provider request failed.' }, 502)
    }
    if (payload?.status !== 'completed') {
      return json({ error: `Ask DW model response did not complete (${payload?.status || 'unknown'}).` }, 502)
    }

    const text = extractOutputText(payload)
    if (!text) return json({ error: 'Ask DW model returned no structured output.' }, 502)

    let output
    try {
      output = JSON.parse(text)
    } catch {
      return json({ error: 'Ask DW model returned invalid structured JSON.' }, 502)
    }

    return json({
      ok: true,
      provider: 'groq',
      role,
      stage,
      model,
      responseId: payload.id ?? null,
      output,
      usage: payload.usage ? {
        inputTokens: payload.usage.input_tokens ?? null,
        outputTokens: payload.usage.output_tokens ?? null,
        totalTokens: payload.usage.total_tokens ?? null,
      } : null,
    })
  } catch (error) {
    return json({ error: error?.message || 'Unexpected Ask DW model error' }, 400)
  }
})

function isCallerEnabled(userId) {
  const allowAll = Deno.env.get('ASK_DW_MODEL_ALLOW_ALL_AUTHENTICATED') === 'true'
  if (allowAll) return true
  const allowed = (Deno.env.get('ASK_DW_MODEL_ALLOWED_USER_IDS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  return allowed.includes(userId)
}

function extractOutputText(payload) {
  for (const item of payload?.output || []) {
    if (item?.type !== 'message') continue
    for (const content of item.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') return content.text
    }
  }
  return null
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      ...extraHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
