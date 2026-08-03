export function normalizeClientText(value) {
  const normalized = String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
  return normalized || null
}

export function normalizeClientEmail(value) {
  return String(value ?? '').trim().toLowerCase() || null
}

export function normalizeClientPhone(value) {
  return String(value ?? '').replace(/\D+/g, '') || null
}

export function normalizeSource(value) {
  return String(value ?? '').trim().toLowerCase() || null
}

export function classifyClientPair(a, b) {
  const aSources = new Set((a.sourceIdentities || []).map(sourceKey).filter(Boolean))
  const sharedSource = (b.sourceIdentities || [])
    .map(sourceKey)
    .find((key) => key && aSources.has(key))
  if (sharedSource) {
    return { classification: 'exact', ruleCode: 'external_id' }
  }

  const aName = normalizeClientText(a.name)
  const bName = normalizeClientText(b.name)
  const aCompany = normalizeClientText(a.company)
  const bCompany = normalizeClientText(b.company)
  const sameName = Boolean(aName && aName === bName)
  const sameCompany = Boolean(aCompany && aCompany === bCompany)
  const aEmail = normalizeClientEmail(a.email)
  const bEmail = normalizeClientEmail(b.email)
  const sameEmail = Boolean(aEmail && aEmail === bEmail)

  if (sameEmail && (sameName || sameCompany)) {
    return { classification: 'exact', ruleCode: 'email_with_name_or_company' }
  }

  const aPhone = normalizeClientPhone(a.phone)
  const bPhone = normalizeClientPhone(b.phone)
  if (aPhone && aPhone === bPhone && (sameName || sameCompany)) {
    return {
      classification: 'review_required',
      ruleCode: 'phone_with_name_or_company',
    }
  }

  const aDomain = emailDomain(aEmail)
  const bDomain = emailDomain(bEmail)
  if (aDomain && aDomain === bDomain && sameCompany) {
    return { classification: 'review_required', ruleCode: 'domain_with_company' }
  }
  if (sameEmail) return { classification: 'review_required', ruleCode: 'email_only' }
  if (sameName) return { classification: 'review_required', ruleCode: 'name_only' }
  if (aPhone && aPhone === bPhone) {
    return { classification: 'review_required', ruleCode: 'phone_only' }
  }
  if (aDomain && aDomain === bDomain) {
    return { classification: 'review_required', ruleCode: 'domain_only' }
  }
  return { classification: 'none', ruleCode: null }
}

function emailDomain(value) {
  return value?.includes('@') ? value.split('@').at(-1) || null : null
}

function sourceKey(value) {
  const source = normalizeSource(value?.source)
  const externalId = String(value?.externalId ?? '').trim()
  return source && externalId ? `${source}:${externalId}` : null
}
