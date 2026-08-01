import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FILE_SIZE_LIMIT_BYTES, ROW_LIMIT, PREVIEW_DISPLAY_CAP } from '../../src/lib/import/limits.js'

test('limits are the exact locked values and are distinct concepts', () => {
  assert.equal(FILE_SIZE_LIMIT_BYTES, 5 * 1024 * 1024)
  assert.equal(ROW_LIMIT, 10000)
  assert.equal(PREVIEW_DISPLAY_CAP, 200)
  assert.notEqual(ROW_LIMIT, PREVIEW_DISPLAY_CAP, 'processing limit must never be conflated with the display cap')
})
