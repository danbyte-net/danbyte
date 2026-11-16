import { createContext, useContext } from "react"

import type { CordEndStore } from "@/lib/cord-run"

/**
 * The room's cords, shared between the devices that draw them
 * (port-plugs) and the cable runs that start at them (cable-trace-3d).
 * Only the 3D room provides one: elsewhere (the device viewer) cords are
 * drawn but nothing reads where they are.
 */
export const CordEndsContext = createContext<CordEndStore | null>(null)

export function useCordEnds(): CordEndStore | null {
  return useContext(CordEndsContext)
}
