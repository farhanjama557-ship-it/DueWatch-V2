import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const IMPORT_LIB_DIR = path.join(__dirname, '..', '..', 'src', 'lib', 'import')

const FORBIDDEN_PATTERNS = [
  /@supabase\/supabase-js/,
  /from ['"].*supabase/i,
  /DataContext/,
  /AuthContext/,
  /\bfetch\(/,
  /XMLHttpRequest/,
  /\bWebSocket\b/,
  /from ['"]node:fs['"]/,
  /from ['"]fs['"]/,
  /require\(['"]fs['"]\)/,
]

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.js')) out.push(full)
  }
  return out
}

test('the import engine has zero Supabase/DataContext/network/filesystem access', () => {
  const files = walk(IMPORT_LIB_DIR)
  assert.ok(files.length >= 8, 'sanity check: expected at least 8 engine modules to scan')
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    for (const pattern of FORBIDDEN_PATTERNS) {
      assert.ok(!pattern.test(content), `${path.relative(IMPORT_LIB_DIR, file)} matches forbidden pattern ${pattern}`)
    }
  }
})

test('the import engine never imports Import.jsx, App.jsx, or any Supabase migration/SQL file', () => {
  const files = walk(IMPORT_LIB_DIR)
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8')
    assert.ok(!content.includes('pages/Import'), `${file} must not import the UI`)
    assert.ok(!/\.sql['"]/.test(content), `${file} must not reference a SQL file`)
  }
})
