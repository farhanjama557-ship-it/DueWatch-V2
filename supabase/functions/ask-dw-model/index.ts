import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeadersForRequest, handleCorsPreflight } from '../_shared/cors.js'
import { consumeRateLimits } from '../_shared/rateLimit.js'
import { readBoundedJson } from '../_shared/requestSecurity.js'
import {
  ASK_DW_OPENAI_ROLE,
  ASK_DW_OPENAI_STAGE,
  assertAskDwOpenAiRequest,
  stageInstructions,
  stageSchema,
} from '../_shared/askDwOpenAiContract.js'

const GROQ_RESPONSES_URL = 'https://api.groq.com/openai/v1/responses'
const MAX_REQUEST_BYTES = 20 * 1024
const MAX_REQUEST_CHARS = 12_000
const PROVIDER_TIMEOUT_MS = 90_000

const ALLOWED_GROQ_MODELS = new Set([
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
])

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return handleCorsPreflight(req)
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405, req)

  try {
    if (Deno.env.get('ASK_DW_MODEL_ENABLED') !== 'true') {
      return json({ error: 'Ask DW live model execution is disabled.' }, 503, req)
    }

    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '')
    if (!jwt) return json({ error: 'Not authenticated' }, 401, req)

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || ''
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
    if (!supabaseUrl || !serviceRoleKey) {
      return json({ error: 'Ask DW server configuration is incomplete.' }, 503, req)
    }

    const admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data: { user }, error: userError } = await admin.auth.getUser(jwt)
    if (userError || !user) return json({ error: 'Not authenticated' }, 401, req)
    if (!isCallerEnabled(user.id)) {
      return json({ error: 'Ask DW live model access is not enabled for this account.' }, 403, req)
    }

    const quota = await consumeRateLimits({
      database: admin,
      userId: user.id,
      limits: [
        { scope: 'ask_dw_model_minute', limit: 6, windowSeconds: 60 },
        { scope: 'ask_dw_model_day', limit: 80, windowSeconds: 86400 },
      ],
    })
    if (!quota.allowed) {
      return json(
        {
          error: 'Ask DW request limit reached. Try again after the cooldown.',
          code: 'DUEWATCH_RATE_LIMITED',
        },
        429,
        req,
        { 'Retry-After': String(quota.retryAfterSeconds || 60) }
      )
    }

    let body
    try {
      body = await readBoundedJson(req, MAX_REQUEST_BYTES)
    } catch (error) {
      const status = Number(error?.status) || 400
      return json(
        {
          error: status === 413 ? 'Ask DW request is too large.' : 'Ask DW request must be valid JSON.',
          code: error?.message || 'INVALID_REQUEST',
        },
        status,
        req
      )
    }

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
        error: 'Ask DW model input is too large for the controlled activation profile.',
        code: 'INPUT_LIMIT',
      }, 413, req)
    }

    const apiKey = Deno.env.get('GROQ_API_KEY')
    if (!apiKey) return json({ error: 'Ask DW model provider is not configured.' }, 503, req)

    const primaryModel = Deno.env.get('GROQ_PRIMARY_MODEL') || 'openai/gpt-oss-120b'
    const verifierModel = Deno.env.get('GROQ_VERIFIER_MODEL') || 'openai/gpt-oss-120b'
    const model = role === ASK_DW_OPENAI_ROLE.VERIFIER ? verifierModel : primaryModel

    if (!ALLOWED_GROQ_MODELS.has(model)) {
      return json({
        error: 'Configured Ask DW model is outside the controlled allowlist.',
        code: 'MODEL_NOT_ALLOWED',
      }, 503, req)
    }

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
          reasoning: { effort: 'medium' },
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
          max_output_tokens:
            stage === ASK_DW_OPENAI_STAGE.VERIFY
              ? 1800
              : stage === ASK_DW_OPENAI_STAGE.PLAN
                ? 1600
                : 1600,
        }),
      })
    } catch (error) {
      if (error?.name === 'AbortError') {
        return json({ error: 'Ask DW model provider timed out.' }, 504, req)
      }
      return json({ error: 'Ask DW model provider could not be reached.' }, 502, req)
    } finally {
      clearTimeout(timeout)
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      return json({ error: 'Ask DW model provider returned an unreadable response.' }, 502, req)
    }

    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after')
      return json({
        error: 'Ask DW model quota is temporarily exhausted. Try again after the limit resets.',
        code: 'GROQ_RATE_LIMITED',
        retryAfterSeconds: retryAfter ? Number(retryAfter) || null : null,
      }, 429, req, retryAfter ? { 'Retry-After': retryAfter } : {})
    }

    if (!response.ok) {
      console.error('Ask DW provider request failed', response.status, payload?.error?.code || 'unknown')
      return json({ error: 'Ask DW model provider request failed.' }, 502, req)
    }
    if (payload?.status !== 'completed') {
      return json({ error: 'Ask DW model response did not complete.' }, 502, req)
    }

    const text = extractOutputText(payload)
    if (!text) return json({ error: 'Ask DW model returned no structured output.' }, 502, req)

    let output
    try {
      output = JSON.parse(text)
    } catch {
      return json({ error: 'Ask DW model returned invalid structured JSON.' }, 502, req)
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
    }, 200, req)
  } catch (error) {
    console.error('ask-dw-model failed', error?.code || error?.name || 'unknown')
    return json({ error: 'Unexpected Ask DW model error.' }, 400, req)
  }
})

function isCallerEnabled(userId) {
  const callerId = String(userId || '').trim()
  if (!callerId) return false

  const allowed = (Deno.env.get('ASK_DW_MODEL_ALLOWED_USER_IDS') || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  if (allowed.length === 0 || allowed.length > 20) return false
  return new Set(allowed).has(callerId)
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

function json(body, status, req, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeadersForRequest(req),
      ...extraHeaders,
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  })
}
