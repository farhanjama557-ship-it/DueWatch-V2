import { evaluateNextActionAuthority } from './nextActionAuthority.js'
import { runPhase2BServerProof } from './dwIntelligencePhase2bServerCore.js'

/**
 * Repository server wiring for the Phase 2B proof.
 *
 * This adapter exists only to bind the pure server core to the exact existing
 * Duewatch authority evaluator. It does not add another authority mechanism
 * and it contains no provider-send path.
 */
export function runDuewatchPhase2BServerProof(args) {
  return runPhase2BServerProof({
    ...args,
    evaluateAuthority: evaluateNextActionAuthority,
  })
}
