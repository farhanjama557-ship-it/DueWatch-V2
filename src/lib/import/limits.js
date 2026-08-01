// Hard safety limits for Phase 1.5A file intake. Kept as named constants so
// the processing limit (ROW_LIMIT) is never confused with a UI display cap
// (PREVIEW_DISPLAY_CAP) — the two are checked at different layers and must
// not be merged into one number.

export const FILE_SIZE_LIMIT_BYTES = 5 * 1024 * 1024 // 5 MiB, exactly
export const ROW_LIMIT = 10000 // maximum data rows (excludes header row)
export const PREVIEW_DISPLAY_CAP = 200 // UI rendering cap only, not a processing limit
