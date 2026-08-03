import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCTION_PROJECT_REF,
  AUTHORIZED_STAGING_PROJECT_REF,
  UnsafeTestEnvironmentError,
  extractProjectRef,
  assertProductionRefAbsent,
  loadTestSupabaseConfig,
  assertAppEnvIsNotProduction,
  createHostAllowlistMonitor,
} from '../src/lib/testEnv.js'

test('extractProjectRef reads the subdomain out of a Supabase URL', () => {
  assert.equal(extractProjectRef(`https://${PRODUCTION_PROJECT_REF}.supabase.co`), PRODUCTION_PROJECT_REF)
  assert.equal(extractProjectRef('https://example.com'), null)
  assert.equal(extractProjectRef(null), null)
})

// --- Required scenario: production ref rejected ---
test('production ref rejected: bare ref', () => {
  assert.throws(
    () => assertProductionRefAbsent({ projectRef: PRODUCTION_PROJECT_REF }),
    UnsafeTestEnvironmentError
  )
})

// --- Required scenario: production URL rejected ---
test('production ref rejected: full URL', () => {
  assert.throws(
    () => assertProductionRefAbsent({ url: `https://${PRODUCTION_PROJECT_REF}.supabase.co` }),
    UnsafeTestEnvironmentError
  )
})

test('production ref rejected: substring anywhere in a candidate string', () => {
  assert.throws(
    () => assertProductionRefAbsent({ url: `https://${PRODUCTION_PROJECT_REF}.supabase.co/rest/v1/rpc/x` }),
    UnsafeTestEnvironmentError
  )
})

test('a genuinely unrelated ref/url passes', () => {
  assert.doesNotThrow(() => assertProductionRefAbsent({ url: 'http://localhost:54321', projectRef: 'local' }))
  assert.doesNotThrow(() => assertProductionRefAbsent({ projectRef: AUTHORIZED_STAGING_PROJECT_REF }))
})

// --- Required scenario: missing test marker rejected ---
test('missing test marker rejected', () => {
  assert.throws(
    () => loadTestSupabaseConfig({}),
    UnsafeTestEnvironmentError
  )
  assert.throws(
    () => loadTestSupabaseConfig({ DUEWATCH_TEST_ENV_MARKER: 'not-test' }),
    UnsafeTestEnvironmentError
  )
})

test('missing mode rejected even with a valid marker', () => {
  assert.throws(
    () => loadTestSupabaseConfig({ DUEWATCH_TEST_ENV_MARKER: 'test' }),
    UnsafeTestEnvironmentError
  )
})

test('does not fall back to VITE_SUPABASE_URL when test config is absent', () => {
  const env = {
    VITE_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
    VITE_SUPABASE_ANON_KEY: 'fake-anon-key',
  }
  // No DUEWATCH_TEST_ENV_MARKER / MODE at all — must fail closed, never
  // silently pick up the app's real config even though it's right there.
  assert.throws(() => loadTestSupabaseConfig(env), UnsafeTestEnvironmentError)
})

// --- Required scenario: explicit local/mock configuration accepted ---
test('explicit local configuration accepted', () => {
  const config = loadTestSupabaseConfig({
    DUEWATCH_TEST_ENV_MARKER: 'test',
    DUEWATCH_TEST_SUPABASE_MODE: 'local',
    DUEWATCH_TEST_SUPABASE_URL: 'http://127.0.0.1:54321',
  })
  assert.equal(config.mode, 'local')
  assert.equal(config.url, 'http://127.0.0.1:54321')
})

test('explicit mock configuration accepted, makes no network claim', () => {
  const config = loadTestSupabaseConfig({
    DUEWATCH_TEST_ENV_MARKER: 'test',
    DUEWATCH_TEST_SUPABASE_MODE: 'mock',
  })
  assert.equal(config.mode, 'mock')
  assert.equal(config.url, null)
})

test('local mode rejects a non-localhost URL, even a plausible-looking one', () => {
  assert.throws(
    () =>
      loadTestSupabaseConfig({
        DUEWATCH_TEST_ENV_MARKER: 'test',
        DUEWATCH_TEST_SUPABASE_MODE: 'local',
        DUEWATCH_TEST_SUPABASE_URL: 'https://some-other-project.supabase.co',
      }),
    UnsafeTestEnvironmentError
  )
})

test('local mode rejects the production ref even if someone points DUEWATCH_TEST_SUPABASE_URL at it', () => {
  assert.throws(
    () =>
      loadTestSupabaseConfig({
        DUEWATCH_TEST_ENV_MARKER: 'test',
        DUEWATCH_TEST_SUPABASE_MODE: 'local',
        DUEWATCH_TEST_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
      }),
    UnsafeTestEnvironmentError
  )
})

// --- Required scenario: authorized staging accepted only for a named
// hosted-verification command (mode must be explicitly requested, ref must
// be the exact authorized one) ---
test('authorized staging accepted only in hosted-staging-authorized mode with the exact ref', () => {
  const config = loadTestSupabaseConfig({
    DUEWATCH_TEST_ENV_MARKER: 'test',
    DUEWATCH_TEST_SUPABASE_MODE: 'hosted-staging-authorized',
    DUEWATCH_TEST_SUPABASE_URL: `https://${AUTHORIZED_STAGING_PROJECT_REF}.supabase.co`,
    DUEWATCH_TEST_SUPABASE_PROJECT_REF: AUTHORIZED_STAGING_PROJECT_REF,
  })
  assert.equal(config.mode, 'hosted-staging-authorized')
  assert.equal(config.projectRef, AUTHORIZED_STAGING_PROJECT_REF)
})

test('hosted-staging-authorized mode rejects any ref other than the one authorized ref, including production', () => {
  assert.throws(
    () =>
      loadTestSupabaseConfig({
        DUEWATCH_TEST_ENV_MARKER: 'test',
        DUEWATCH_TEST_SUPABASE_MODE: 'hosted-staging-authorized',
        DUEWATCH_TEST_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
        DUEWATCH_TEST_SUPABASE_PROJECT_REF: PRODUCTION_PROJECT_REF,
      }),
    UnsafeTestEnvironmentError
  )
  assert.throws(
    () =>
      loadTestSupabaseConfig({
        DUEWATCH_TEST_ENV_MARKER: 'test',
        DUEWATCH_TEST_SUPABASE_MODE: 'hosted-staging-authorized',
        DUEWATCH_TEST_SUPABASE_URL: 'https://some-random-project.supabase.co',
        DUEWATCH_TEST_SUPABASE_PROJECT_REF: 'some-random-project',
      }),
    UnsafeTestEnvironmentError
  )
})

test('unknown mode string is rejected, not silently treated as one of the known modes', () => {
  assert.throws(
    () =>
      loadTestSupabaseConfig({
        DUEWATCH_TEST_ENV_MARKER: 'test',
        DUEWATCH_TEST_SUPABASE_MODE: 'production',
      }),
    UnsafeTestEnvironmentError
  )
})

test('assertAppEnvIsNotProduction throws when the app itself is configured against production', () => {
  assert.throws(
    () => assertAppEnvIsNotProduction({ VITE_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` }),
    UnsafeTestEnvironmentError
  )
  assert.doesNotThrow(() => assertAppEnvIsNotProduction({ VITE_SUPABASE_URL: 'http://127.0.0.1:54321' }))
  assert.doesNotThrow(() => assertAppEnvIsNotProduction({}))
})

test('host allowlist monitor records and fails on an unexpected host', () => {
  const monitor = createHostAllowlistMonitor(['pmxivrxjboytemrgjwxx.supabase.co'])
  monitor.record('http://localhost:5175/src/lib/supabase.js')
  monitor.record('https://pmxivrxjboytemrgjwxx.supabase.co/rest/v1/rpc/x')
  assert.doesNotThrow(() => monitor.assertClean())

  monitor.record(`https://${PRODUCTION_PROJECT_REF}.supabase.co/rest/v1/rpc/resolve_or_create_client`)
  assert.throws(() => monitor.assertClean(), UnsafeTestEnvironmentError)
  assert.equal(monitor.violations.length, 1)
})

test('host allowlist monitor allows any localhost port without being told about it explicitly', () => {
  const monitor = createHostAllowlistMonitor([])
  monitor.record('http://localhost:5175/foo')
  monitor.record('http://127.0.0.1:54321/bar')
  assert.doesNotThrow(() => monitor.assertClean())
})
