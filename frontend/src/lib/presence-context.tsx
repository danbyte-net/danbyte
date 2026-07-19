import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

import { type PresenceMode, type PresentUser } from "@/lib/api"
import { usePresence } from "@/lib/use-presence"

// Presence now lives in the global top bar (SiteHeader), not in each page's own
// crowded action header. A page announces the object it's on via
// `useRegisterPresence(type, id, mode)`; the provider runs the *single* WS
// subscription for that target and the header renders who's here. Only one
// object is ever active at a time (one page mounted), so a single target +
// connection is all we need.

interface PresenceTarget {
  type: string
  id: string
  mode: PresenceMode
}

interface PresenceContextValue {
  present: PresentUser[]
  setTarget: (target: PresenceTarget | null) => void
}

const PresenceContext = createContext<PresenceContextValue | null>(null)

export function PresenceProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<PresenceTarget | null>(null)
  // `usePresence` disables itself when the id is undefined, so a null target
  // simply yields an empty present list (and no socket).
  const present = usePresence(
    target?.type ?? "",
    target?.id,
    target?.mode ?? "viewing"
  )
  return (
    <PresenceContext.Provider value={{ present, setTarget }}>
      {children}
    </PresenceContext.Provider>
  )
}

// Read the present users — used by the SiteHeader to render the presence bar.
export function usePresentUsers(): PresentUser[] {
  return useContext(PresenceContext)?.present ?? []
}

// Announce the object the current page is on. Registers on mount, clears on
// unmount, so the global header always reflects the page you're looking at.
// Pass `id = undefined` to stay disabled while the object loads.
export function useRegisterPresence(
  type: string,
  id: string | undefined,
  mode: PresenceMode = "viewing"
): void {
  // Depend on the *stable* setter, not the context value object. The provider
  // recreates that object on every WS update, so depending on it here would
  // re-run the effect → setTarget → re-render → loop ("Maximum update depth").
  // `setTarget` is a useState dispatcher, so its identity never changes.
  const setTarget = useContext(PresenceContext)?.setTarget
  useEffect(() => {
    if (!setTarget) return
    if (!id) {
      setTarget(null)
      return
    }
    setTarget({ type, id, mode })
    return () => setTarget(null)
  }, [setTarget, type, id, mode])
}
