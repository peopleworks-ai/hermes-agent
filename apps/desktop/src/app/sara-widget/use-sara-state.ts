import { useCallback, useEffect, useState } from 'react'

import { SARA_DEFAULT_STATE, type SaraLearning, type SaraWidgetState, type SaraWorkspace } from '@/store/sara'

/**
 * Live widget state, pushed from the main-process store — never polled.
 *
 * Every bridge call is `?.`-guarded and falls back to the default state, so the surface still
 * renders when `hermesDesktop` is absent. That is not defensive noise: opening
 * `http://127.0.0.1:5174/?win=widget` in a plain browser is the ONLY way this UI can be looked at
 * from the headless Linux box it was written on. If it hard-required the bridge, it could not be
 * seen at all before shipping to a Windows machine.
 *
 * The setters resolve with the SETTLED state (main returns it after the dialog), so a cancelled
 * consent leaves the radio exactly where it was. We deliberately do not set state optimistically —
 * an optimistic "Watching" that then unwinds is a UI briefly claiming to record when it is not.
 */
export function useSaraState() {
  const [state, setState] = useState<SaraWidgetState>(SARA_DEFAULT_STATE)

  useEffect(() => {
    let alive = true
    const bridge = window.hermesDesktop?.sara

    void bridge?.get().then(s => {
      if (alive && s) setState(s)
    })

    const unsubscribe = bridge?.onState(s => {
      if (alive && s) setState(s)
    })

    return () => {
      alive = false
      unsubscribe?.()
    }
  }, [])

  const setWorkspace = useCallback(async (mode: SaraWorkspace) => {
    const next = await window.hermesDesktop?.sara?.setWorkspace(mode)
    if (next) setState(next)
  }, [])

  const setLearning = useCallback(async (mode: SaraLearning) => {
    const next = await window.hermesDesktop?.sara?.setLearning(mode)
    if (next) setState(next)
  }, [])

  const openWebApp = useCallback(() => {
    void window.hermesDesktop?.sara?.openWebApp()
  }, [])

  const openSetup = useCallback(() => {
    void window.hermesDesktop?.sara?.openSetup()
  }, [])

  const quit = useCallback(() => {
    void window.hermesDesktop?.sara?.quit()
  }, [])

  return { state, setWorkspace, setLearning, openWebApp, openSetup, quit }
}
