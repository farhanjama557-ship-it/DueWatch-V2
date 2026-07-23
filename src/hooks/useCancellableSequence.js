import { useCallback, useEffect, useRef } from 'react'

/** Rejects with AbortError if `signal` fires before `ms` elapses. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = () => {
      window.clearTimeout(timeoutId)
      signal.removeEventListener('abort', onAbort)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Returns `run(asyncFn)`. Calling it aborts whatever run is currently in
 * flight before starting the new one, and unmounting aborts the current
 * run too — so there is never more than one live sequence, and nothing it
 * schedules can call setState after the component is gone. `asyncFn`
 * receives the AbortSignal for that run and should pass it to every
 * `sleep()` call inside it.
 */
export function useCancellableRun() {
  const controllerRef = useRef(null)

  useEffect(() => {
    return () => controllerRef.current?.abort()
  }, [])

  return useCallback((asyncFn) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    return asyncFn(controller.signal).catch((err) => {
      if (err?.name === 'AbortError') return undefined
      throw err
    })
  }, [])
}
