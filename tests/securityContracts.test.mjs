import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

function read(path) {
  return fs.readFileSync(new URL('../' + path, import.meta.url), 'utf8')
}

test('browser CORS never uses a wildcard origin', () => {
  const cors = read('supabase/functions/_shared/cors.js')
  assert.doesNotMatch(cors, /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/)
  assert.match(cors, /DUEWATCH_ALLOWED_ORIGINS/)
  assert.match(cors, /Origin not allowed/)
})

test('Autopilot scheduler requires a verified service-role JWT', () => {
  const scheduler = read('supabase/functions/autopilot-scheduler/index.ts')
  assert.match(scheduler, /verifiedJwtRole\(req\) !== 'service_role'/)
  assert.match(scheduler, /req\.method !== 'POST'/)
  assert.doesNotMatch(scheduler, /return json\(\{ usersProcessed: summaries\.length, summaries \}\)/)
})

test('manual reminder sends are bounded, rate-limited, and durably claimed', () => {
  const fn = read('supabase/functions/send-reminder-email/index.ts')
  assert.match(fn, /readBoundedJson/)
  assert.match(fn, /consumeRateLimits/)
  assert.match(fn, /acquire_external_action_claim/)
  assert.match(fn, /resolve_external_action_claim/)
  assert.match(fn, /SEND_UNCERTAIN/)
  assert.match(fn, /projectionComplete/)
})

test('browser reminder client no longer writes post-send evidence itself', () => {
  const reminders = read('src/lib/reminders.js')
  assert.doesNotMatch(reminders, /from\('reminders'\)\.insert/)
  assert.doesNotMatch(reminders, /logEvent\('reminder_sent'/)
  assert.match(reminders, /Edge Function now owns the canonical execution receipt/)
})

test('Ask DW live provider has DueWatch-side quotas and no allow-all bypass', () => {
  const fn = read('supabase/functions/ask-dw-model/index.ts')
  assert.match(fn, /consumeRateLimits/)
  assert.match(fn, /ask_dw_model_minute/)
  assert.match(fn, /readBoundedJson/)
  assert.doesNotMatch(fn, /ASK_DW_MODEL_ALLOW_ALL_AUTHENTICATED/)
})

test('Vercel response headers establish a browser security baseline', () => {
  const config = JSON.parse(read('vercel.json'))
  const headers = Object.fromEntries(config.headers[0].headers.map((item) => [item.key, item.value]))
  assert.match(headers['Content-Security-Policy'], /frame-ancestors 'none'/)
  assert.match(headers['Content-Security-Policy'], /object-src 'none'/)
  assert.equal(headers['X-Content-Type-Options'], 'nosniff')
  assert.equal(headers['X-Frame-Options'], 'DENY')
  assert.ok(headers['Strict-Transport-Security'])
})

test('frontend Supabase client accepts publishable config and contains no server secret variable', () => {
  const client = read('src/lib/supabase.js')
  assert.match(client, /VITE_SUPABASE_PUBLISHABLE_KEY/)
  assert.doesNotMatch(client, /SUPABASE_SERVICE_ROLE_KEY/)
  assert.doesNotMatch(client, /RESEND_API_KEY|GROQ_API_KEY/)
})
