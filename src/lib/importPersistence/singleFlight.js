// Acquires the ref synchronously, before React can render a disabled state.
// The lock always releases after success or failure so an explicit later
// retry is possible.
export async function runSingleFlight(lockRef, operation) {
  if (lockRef.current) return { started: false }
  lockRef.current = true
  try {
    return { started: true, value: await operation() }
  } finally {
    lockRef.current = false
  }
}
