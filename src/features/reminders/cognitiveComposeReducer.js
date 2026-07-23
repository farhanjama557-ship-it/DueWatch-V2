// CognitiveCompose's phase machine. `approving` and `sending` are collapsed
// into one `sending` phase — this app's Approve & Send is a single action
// with no separate confirmation step, so a distinct `approving` phase
// would describe a moment that doesn't actually exist in the product.
export const initialComposeState = {
  phase: 'closed', // closed | generating | revealing | review | editing | sending | sent | error
  errorKind: null, // 'draft' | 'send' | null
  errorMessage: '',
  draft: '',
  tone: 'friendly',
}

export function cognitiveComposeReducer(state, action) {
  switch (action.type) {
    case 'OPEN':
      return { ...initialComposeState, phase: 'generating', tone: action.tone }
    case 'DRAFT_READY':
      return { ...state, phase: 'revealing', draft: action.draft }
    case 'DRAFT_ERROR':
      return { ...state, phase: 'error', errorKind: 'draft', errorMessage: action.message }
    case 'REVEAL_DONE':
      return { ...state, phase: 'review' }
    case 'START_EDIT':
      return { ...state, phase: 'editing' }
    case 'EDIT_CHANGE':
      return { ...state, draft: action.draft }
    case 'STOP_EDIT':
      return { ...state, phase: 'review' }
    case 'PICK_TONE':
      return { ...state, tone: action.tone, draft: action.draft }
    case 'SEND_START':
      return { ...state, phase: 'sending' }
    case 'SEND_SUCCESS':
      return { ...state, phase: 'sent' }
    case 'SEND_ERROR':
      return { ...state, phase: 'error', errorKind: 'send', errorMessage: action.message }
    case 'RETRY_DRAFT':
      return { ...state, phase: 'generating', errorKind: null, errorMessage: '' }
    case 'RETRY_SEND':
      return { ...state, phase: 'sending', errorKind: null, errorMessage: '' }
    case 'CLOSE':
      return { ...initialComposeState }
    default:
      return state
  }
}
