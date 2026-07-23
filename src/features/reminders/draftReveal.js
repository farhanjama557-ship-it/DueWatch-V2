// Deterministic word-by-word reveal timing for CognitiveCompose (spec §7).
// Pure functions, no React, no Math.random() — the same draft always
// produces the same token list and the same schedule.

const BASE_WORD_DELAY = 145
const PUNCT_EXTRA = {
  word: 0,
  clausePause: 90, // , ; :
  sentenceEnd: 260, // . ! ?
  paragraphBreak: 360, // trailing \n\n
}
export const TOKEN_FADE_MS = 120
const MIN_TOTAL_MS = 4800
const MAX_TOTAL_MS = 9000
const MIN_BASE_DELAY = 110
const MAX_BASE_DELAY = 170

/**
 * Splits `text` into whitespace-preserving tokens. Each token is the
 * original substring (word + its trailing whitespace) so re-joining every
 * token's `text` reproduces the input exactly. `\S+` naturally keeps
 * invoice numbers, currency amounts, and email addresses intact since none
 * of them contain internal whitespace.
 */
export function tokenizeDraft(text) {
  if (!text || !text.trim()) return []
  const matches = text.match(/\S+\s*/g) || []
  return matches.map((raw) => {
    const trimmedEnd = raw.replace(/\s+$/, '')
    const trailingWhitespace = raw.slice(trimmedEnd.length)
    let kind = 'word'
    if (trailingWhitespace.includes('\n\n')) kind = 'paragraphBreak'
    else if (/[.!?]$/.test(trimmedEnd)) kind = 'sentenceEnd'
    else if (/[,;:]$/.test(trimmedEnd)) kind = 'clausePause'
    return { text: raw, kind }
  })
}

/**
 * Per-token delay (ms) before that token appears, scaled so the total
 * reveal duration stays within [4.8s, 9s] regardless of draft length —
 * a two-word draft doesn't finish instantly and a long one doesn't drag
 * past a reasonable ceiling.
 */
export function computeRevealSchedule(tokens) {
  if (tokens.length === 0) return []
  const punctuationExtraTotal = tokens.reduce((sum, t) => sum + PUNCT_EXTRA[t.kind], 0)
  const rawTotal = tokens.length * BASE_WORD_DELAY + punctuationExtraTotal
  const target = Math.min(Math.max(rawTotal, MIN_TOTAL_MS), MAX_TOTAL_MS)
  const rawBase = (target - punctuationExtraTotal) / tokens.length
  const base = Math.min(Math.max(rawBase, MIN_BASE_DELAY), MAX_BASE_DELAY)
  return tokens.map((t) => Math.round(base + PUNCT_EXTRA[t.kind]))
}
