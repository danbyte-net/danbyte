import { useSyncExternalStore } from "react"

/**
 * Cable ways in a 3D view (docs/dcim/racks.md → Cable ways → In 3D): one
 * `CableWayStore` per view holds the cable picked - in this layer, the
 * room's cable card or the Way card's Show in rack - and every rack's
 * layer lights that cable's way and ghosts the rest; the room's runs
 * ghost theirs too. `onPick`, given, takes a click instead of the store
 * (the room opens its cable card, which sets the store back).
 */
export class CableWayStore {
  private selectedId: string | null = null
  private listeners = new Set<() => void>()
  private version = 0

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = () => this.version

  get selected(): string | null {
    return this.selectedId
  }

  select(id: string | null) {
    if (this.selectedId === id) return
    this.selectedId = id
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  toggle(id: string) {
    this.select(this.selectedId === id ? null : id)
  }
}

const noVersion = () => 0

/** Re-render on the store's changes. */
export function useCableWayStore(store: CableWayStore): string | null {
  useSyncExternalStore(store.subscribe, store.getVersion, noVersion)
  return store.selected
}
