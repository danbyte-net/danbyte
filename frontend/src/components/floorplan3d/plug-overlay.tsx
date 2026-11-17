import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
} from "react"
import type { ReactNode } from "react"

/**
 * What one drawn device's seated parts (port-plugs) and its port markers
 * (device-model-port-markers) tell each other, so the Ports overlay reads
 * over transceivers and cords:
 *
 * - the parts publish, per port name, how far in front of the opening
 *   their front face stands (m, in the markers' frame) and whether they
 *   are ghosted - the markers draw the wash there instead of at the cage
 *   mouth;
 * - the markers publish the hovered and selected ports, whose own parts
 *   stay solid while the rest ghost.
 *
 * One store per drawn device (PlugOverlayScope around its model and its
 * markers); without one, neither side shares anything.
 */
export class PlugOverlayStore {
  private frontsMap: ReadonlyMap<string, number> = new Map()
  private ghostOn = false
  private solidSet: ReadonlySet<string> = new Set()
  private frontsSig = ""
  private solidSig = ""
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = () => this.version

  private bump() {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  /** Each port's part front (m out of the opening), and whether the
   * parts are ghosted. A publish equal to the last changes nothing. */
  setFronts(fronts: ReadonlyMap<string, number>, ghost: boolean) {
    const sig = `${ghost ? 1 : 0}|${[...fronts]
      .map(([k, v]) => `${k}\u0001${v.toFixed(5)}`)
      .sort()
      .join("\u0000")}`
    if (sig === this.frontsSig) return
    this.frontsSig = sig
    this.frontsMap = new Map(fronts)
    this.ghostOn = ghost
    this.bump()
  }

  /** The ports whose parts stay solid (hovered, selected). */
  setSolid(names: Iterable<string>) {
    const list = [...new Set(names)].sort()
    const sig = list.join("\u0000")
    if (sig === this.solidSig) return
    this.solidSig = sig
    this.solidSet = new Set(list)
    this.bump()
  }

  get fronts(): ReadonlyMap<string, number> {
    return this.frontsMap
  }

  get ghost(): boolean {
    return this.ghostOn
  }

  get solid(): ReadonlySet<string> {
    return this.solidSet
  }

  /** A key that changes only with the fronts and the ghosting. */
  get frontsKey(): string {
    return this.frontsSig
  }
}

const PlugOverlayContext = createContext<PlugOverlayStore | null>(null)

/** One device's store, for its parts and its markers. */
export function PlugOverlayScope({ children }: { children: ReactNode }) {
  const [store] = useState(() => new PlugOverlayStore())
  return (
    <PlugOverlayContext.Provider value={store}>
      {children}
    </PlugOverlayContext.Provider>
  )
}

const noSubscribe = () => () => {}
const noVersion = () => 0

/** The device's store, re-rendering on its changes; null outside a scope. */
export function usePlugOverlay(): PlugOverlayStore | null {
  const store = useContext(PlugOverlayContext)
  useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getVersion ?? noVersion,
    noVersion
  )
  return store
}
