import { useCallback, useEffect, useState } from 'react'
import CompanyBrainReview from '../features/companyBrain/CompanyBrainReview'
import {
  loadFounderReviewReadModel,
  requestAuthorityRevocation,
  submitFounderReviewDecision,
} from '../lib/companyBrain/founderReviewLoader'

/**
 * M2G-G6 Company Brain review route.
 *
 * Everything shown here is the authenticated tenant's own durable Company Brain
 * state. Approving what DW understood records a founder review decision and
 * nothing else; DW authority is granted or revoked only through the explicit
 * G5 path, from its own section, with its own controls.
 */
export default function CompanyBrain() {
  const [readModel, setReadModel] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busyKey, setBusyKey] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await loadFounderReviewReadModel({})
      setReadModel(result.readModel)
    } catch (loadError) {
      // Fail closed: a read that did not succeed is never shown as reviewed.
      setReadModel(null)
      setError(loadError.message || 'Company Brain review could not be loaded.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const onReviewAction = useCallback(async ({ reviewKey, action, expectedRevision, subjectFingerprint, reviewedValue }) => {
    const item = (readModel?.items || []).find((entry) => entry.reviewKey === reviewKey)
    if (!item) return
    setBusyKey(reviewKey)
    setError(null)
    try {
      await submitFounderReviewDecision({
        item,
        action,
        expectedRevision,
        subjectFingerprint,
        reviewedValue,
        // Same decision retried is the same decision; a different one is distinct.
        idempotencyKey: `${reviewKey}:${expectedRevision}:${action}`,
      })
      await load()
    } catch (actionError) {
      setError(actionError.message || 'Your review decision was not saved.')
    } finally {
      setBusyKey(null)
    }
  }, [readModel, load])

  const onRevokeAuthority = useCallback(async (grantId) => {
    setError(null)
    try {
      await requestAuthorityRevocation({
        grantId,
        idempotencyKey: `revoke:${grantId}`,
        reason: 'Revoked by the founder from Company Brain review.',
      })
      await load()
    } catch (revokeError) {
      setError(revokeError.message || 'Authority was not revoked.')
    }
  }, [load])

  return (
    <CompanyBrainReview
      readModel={readModel}
      loading={loading}
      error={error}
      busyKey={busyKey}
      onReviewAction={onReviewAction}
      onRevokeAuthority={onRevokeAuthority}
    />
  )
}
