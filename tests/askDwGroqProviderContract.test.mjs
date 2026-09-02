import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const providerUrl = new URL('../supabase/functions/ask-dw-g7-model/index.ts', import.meta.url)
const source = fs.readFileSync(providerUrl, 'utf8')

test('Ask DW provider is wired to Groq, not the paid OpenAI endpoint', () => {
  assert.match(source, /https:\/\/api\.groq\.com\/openai\/v1\/responses/)
  assert.match(source, /Deno\.env\.get\('GROQ_API_KEY'\)/)
  assert.match(source, /GROQ_PRIMARY_MODEL/)
  assert.match(source, /GROQ_VERIFIER_MODEL/)
  assert.doesNotMatch(source, /https:\/\/api\.openai\.com\/v1\/responses/)
  assert.doesNotMatch(source, /Deno\.env\.get\('OPENAI_API_KEY'\)/)
  assert.doesNotMatch(source, /OPENAI_PRIMARY_MODEL/)
  assert.doesNotMatch(source, /OPENAI_VERIFIER_MODEL/)
})

test('Ask DW remains fail-closed before any provider credential is read', () => {
  const gateIndex = source.indexOf("Deno.env.get('ASK_DW_MODEL_ENABLED')")
  const keyIndex = source.indexOf("Deno.env.get('GROQ_API_KEY')")
  assert.ok(gateIndex >= 0)
  assert.ok(keyIndex > gateIndex)
  assert.match(source, /ASK_DW_MODEL_ALLOW_ALL_AUTHENTICATED/)
  assert.match(source, /ASK_DW_MODEL_ALLOWED_USER_IDS/)
})

test('Groq controlled provider only allows strict-schema GPT-OSS models', () => {
  assert.match(source, /openai\/gpt-oss-120b/)
  assert.match(source, /openai\/gpt-oss-20b/)
  assert.match(source, /ALLOWED_GROQ_MODELS/)
  assert.match(source, /type:\s*'json_schema'/)
  assert.match(source, /strict:\s*true/)
})

test('free-tier guardrails bound request and output size', () => {
  assert.match(source, /MAX_REQUEST_CHARS\s*=\s*12_000/)
  assert.match(source, /FREE_TIER_INPUT_LIMIT/)
  assert.match(source, /1800/)
  assert.match(source, /1600/)
})

test('Groq rate limits are surfaced as 429 rather than hidden as provider failure', () => {
  assert.match(source, /response\.status\s*===\s*429/)
  assert.match(source, /GROQ_RATE_LIMITED/)
  assert.match(source, /Retry-After/)
  assert.match(source, /\},\s*429,/)
})

test('successful responses identify Groq and preserve usage receipt', () => {
  assert.match(source, /provider:\s*'groq'/)
  assert.match(source, /inputTokens/)
  assert.match(source, /outputTokens/)
  assert.match(source, /totalTokens/)
  assert.match(source, /ASK_DW_G7_MODEL_CONTRACT_VERSION/)
})
