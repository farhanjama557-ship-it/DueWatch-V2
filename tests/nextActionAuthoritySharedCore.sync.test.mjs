import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Post-2A.1 execution safety checkpoint, BLOCKER 2: the scheduler/Edge
// Function boundary must call the EXACT SAME Phase 2A.1 authority engine
// as the browser, never a second, parallel, simplified one. This repo's
// established convention for browser/Deno-shared logic is duplication
// with a cross-reference comment (see src/lib/ruleSchedule.js's
// ruleMatches vs supabase/functions/_shared/rules.js's ruleMatches), not a
// cross-boundary import — so supabase/functions/_shared/nextActionAuthority.js
// is a second copy of src/lib/nextActionAuthority.js. This test is the
// anti-drift enforcement: it fails loudly the moment the two copies'
// shared cores diverge, which is the whole safety argument for allowing
// the duplication in the first place.

const MARKER = '// ==== SHARED AUTHORITY CORE (byte-identical in both copies past this line) ===='

function sharedCoreOf(relativePath) {
  const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', relativePath)
  const content = readFileSync(filePath, 'utf8')
  const idx = content.indexOf(MARKER)
  assert.ok(idx !== -1, `${relativePath} is missing the shared-core marker comment`)
  return content.slice(idx + MARKER.length)
}

test('src/lib/nextActionAuthority.js and supabase/functions/_shared/nextActionAuthority.js are byte-identical past the shared-core marker', () => {
  const browserCore = sharedCoreOf('src/lib/nextActionAuthority.js')
  const denoCore = sharedCoreOf('supabase/functions/_shared/nextActionAuthority.js')
  assert.equal(denoCore, browserCore)
})
