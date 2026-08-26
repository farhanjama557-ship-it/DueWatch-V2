import { runAskDwDeterministicCore } from './askDwRuntime.js'
import { createAskDwOrchestrator } from './askDwOrchestrator.js'

/**
 * Convenience constructor used by app/server adapters. Provider/model and
 * read-tool implementations remain injected so this module has no network,
 * provider-send, database-write, or secret handling capability of its own.
 */
export function createDefaultAskDwOrchestrator({ primaryModel, verifierModel, toolRegistry } = {}) {
  return createAskDwOrchestrator({
    deterministicCore: runAskDwDeterministicCore,
    primaryModel,
    verifierModel,
    toolRegistry,
  })
}
