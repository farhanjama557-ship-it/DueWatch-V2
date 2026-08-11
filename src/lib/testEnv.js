// Fail-closed test-environment safety contract.
//
// Why this exists: the PR #26 integration walkthrough attempted a request
// to the production Supabase hostname because the local dev environment's
// own VITE_SUPABASE_URL (the app's real runtime config) happened to point
// at production, and nothing stopped a test process from inheriting it.
// The request only failed because this particular sandbox has no outbound
// network route to Supabase — an accident of infrastructure, not a
// guarantee. This module makes that class of risk structurally impossible
// instead of incidentally avoided.
//
// Core rules, enforced here rather than left to convention:
//   1. Test processes read ONLY DUEWATCH_TEST_* variables, never
//      VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY (the app's real config).
//   2. Missing test configuration throws — it never silently falls back
//      to the app's normal environment variables.
//   3. Any configured URL or project ref that matches the production
//      project is rejected, in every mode, with no exception.
//   4. A hosted (non-local) test target is accepted only when it is
//      EXACTLY the one authorized staging project ref, and only when the
//      caller has explicitly asked for hosted-staging-authorized mode —
//      never as an implicit default.

export const PRODUCTION_PROJECT_REF = 'llviufxoujmsnrlyptxg'
export const AUTHORIZED_STAGING_PROJECT_REF = 'pmxivrxjboytemrgjwxx'

export const TEST_SUPABASE_MODES = Object.freeze({
  LOCAL: 'local',
  MOCK: 'mock',
  HOSTED_STAGING_AUTHORIZED: 'hosted-staging-authorized',
})

export class UnsafeTestEnvironmentError extends Error {
  constructor(message) {
    super(message)
    this.name = 'UnsafeTestEnvironmentError'
  }
}

// Supabase project URLs are always https://<ref>.supabase.co — extract the
// ref so a raw URL and a bare ref can be checked the same way.
export function extractProjectRef(url) {
  if (!url) return null
  const m = String(url).match(/^https?:\/\/([a-z0-9-]+)\.supabase\.co/i)
  return m ? m[1] : null
}

// Rejects the production ref wherever it could hide: a bare ref, a full
// URL containing it as the subdomain, or (defensively) as a substring of
// either — a substring match is deliberately stricter than necessary
// rather than risk a false negative from an unexpected URL shape.
export function assertProductionRefAbsent({ url, projectRef } = {}) {
  const candidates = [url, projectRef, extractProjectRef(url)]
    .filter((v) => v != null && v !== '')
    .map(String)
  const hit = candidates.find((c) => c.includes(PRODUCTION_PROJECT_REF))
  if (hit) {
    throw new UnsafeTestEnvironmentError(
      `Refusing to proceed: test configuration references the production project ref "${PRODUCTION_PROJECT_REF}" (found in "${hit}"). Production is never a valid test target.`
    )
  }
}

// Loads and validates test-only Supabase configuration from `env` (defaults
// to process.env, injectable for tests). Fails closed on anything missing
// or ambiguous — never returns a partially-valid config, never falls back
// to VITE_SUPABASE_URL/VITE_SUPABASE_ANON_KEY.
export function loadTestSupabaseConfig(env = process.env) {
  const marker = env.DUEWATCH_TEST_ENV_MARKER
  if (marker !== 'test') {
    throw new UnsafeTestEnvironmentError(
      'Missing or invalid DUEWATCH_TEST_ENV_MARKER (must be exactly "test"). Refusing to run — this guards against accidentally inheriting normal app configuration.'
    )
  }

  const mode = env.DUEWATCH_TEST_SUPABASE_MODE
  if (!mode) {
    throw new UnsafeTestEnvironmentError(
      `Missing DUEWATCH_TEST_SUPABASE_MODE — must be one of: ${Object.values(TEST_SUPABASE_MODES).join(', ')}.`
    )
  }

  if (mode === TEST_SUPABASE_MODES.MOCK) {
    // Mock mode makes no real network connection at all — nothing to
    // validate beyond the marker/mode already checked above.
    return { mode, url: null, projectRef: null }
  }

  if (mode === TEST_SUPABASE_MODES.LOCAL) {
    const url = env.DUEWATCH_TEST_SUPABASE_URL
    if (!url) {
      throw new UnsafeTestEnvironmentError('local mode requires DUEWATCH_TEST_SUPABASE_URL to be set.')
    }
    const projectRef = env.DUEWATCH_TEST_SUPABASE_PROJECT_REF ?? extractProjectRef(url)
    assertProductionRefAbsent({ url, projectRef })
    if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(url)) {
      throw new UnsafeTestEnvironmentError(
        `local mode requires a localhost/127.0.0.1 URL, got "${url}". Use hosted-staging-authorized mode for a real hosted target.`
      )
    }
    return { mode, url, projectRef }
  }

  if (mode === TEST_SUPABASE_MODES.HOSTED_STAGING_AUTHORIZED) {
    const url = env.DUEWATCH_TEST_SUPABASE_URL
    const projectRef = env.DUEWATCH_TEST_SUPABASE_PROJECT_REF
    if (projectRef !== AUTHORIZED_STAGING_PROJECT_REF) {
      throw new UnsafeTestEnvironmentError(
        `hosted-staging-authorized mode requires DUEWATCH_TEST_SUPABASE_PROJECT_REF to be exactly "${AUTHORIZED_STAGING_PROJECT_REF}", got ${JSON.stringify(projectRef)}.`
      )
    }
    assertProductionRefAbsent({ url, projectRef })
    return { mode, url, projectRef }
  }

  throw new UnsafeTestEnvironmentError(
    `Unknown DUEWATCH_TEST_SUPABASE_MODE "${mode}" — must be one of: ${Object.values(TEST_SUPABASE_MODES).join(', ')}.`
  )
}

// For any test that will launch the real app (which reads VITE_SUPABASE_URL
// directly): a defense-in-depth check that the app's own runtime config
// isn't pointed at production before letting a browser test proceed.
export function assertAppEnvIsNotProduction(env = process.env) {
  const appUrl = env.VITE_SUPABASE_URL
  if (appUrl && extractProjectRef(appUrl) === PRODUCTION_PROJECT_REF) {
    throw new UnsafeTestEnvironmentError(
      "The app's own VITE_SUPABASE_URL points at the production project. Refusing to run tests against it."
    )
  }
}

// Records outbound request URLs observed during a browser/integration test
// and fails if any target a host outside an explicit allowlist (localhost
// and 127.0.0.1 are always implicitly allowed — that's where the app and
// its local Supabase stack, if any, actually run).
export function createHostAllowlistMonitor(allowedHosts = []) {
  const violations = []
  function isAllowedHost(host) {
    if (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return true
    return allowedHosts.some((h) => host === h || host.endsWith(`.${h}`))
  }
  return {
    record(url) {
      let host
      try {
        host = new URL(url).host
      } catch {
        return
      }
      if (!isAllowedHost(host)) violations.push(url)
    },
    violations,
    assertClean() {
      if (violations.length > 0) {
        throw new UnsafeTestEnvironmentError(
          `Unexpected outbound request(s) during test to disallowed host(s): ${JSON.stringify(violations)}`
        )
      }
    },
  }
}
