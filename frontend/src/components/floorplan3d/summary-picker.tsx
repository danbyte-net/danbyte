import { useMemo, useSyncExternalStore } from "react"

import { sceneTileIcon } from "@/components/object-icon"
import { clusterMembersOf } from "@/components/floorplan/cluster-members"
import type { ClusterMember } from "@/components/floorplan/cluster-members"
import {
  ClusterHoverCard,
  ClusterMembersPanel,
} from "@/components/floorplan/cluster-members-view"

import type { SceneTile } from "./world"

// The room's summary plates (name-layout.ts) answer the pointer as the 2D
// plan's icon clusters do: a hover lists the members, a click opens the
// panel to pick one or frame them all. The plates are picked in the scene
// (readable-names.tsx); what they hold reaches the DOM through this store,
// outside the scene's state, so a hover never re-renders the room.

/** A summary plate under the pointer or clicked: its members (tile ids)
 * and where (viewport px). */
export interface SummaryHit {
  id: string
  name: string
  members: readonly string[]
  x: number
  y: number
}

interface SummaryState {
  hover: SummaryHit | null
  open: SummaryHit | null
}

export interface SummaryStore {
  get: () => SummaryState
  subscribe: (listener: () => void) => () => void
  /** The plate under the pointer, or none. A move over the same plate
   * keeps the first spot, so the card holds still. */
  hover: (hit: SummaryHit | null) => void
  open: (hit: SummaryHit | null) => void
}

export function createSummaryStore(): SummaryStore {
  let state: SummaryState = { hover: null, open: null }
  const listeners = new Set<() => void>()
  const emit = (next: SummaryState) => {
    state = next
    for (const l of listeners) l()
  }
  return {
    get: () => state,
    subscribe: (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    hover: (hit) => {
      if ((hit?.id ?? null) === (state.hover?.id ?? null)) return
      emit({ ...state, hover: hit })
    },
    open: (hit) => {
      if (hit === state.open) return
      emit({ hover: null, open: hit })
    },
  }
}

/** A room tile as a cluster lists it. */
export function sceneTileMember(
  t: Pick<SceneTile, "id" | "kind" | "icon" | "color">,
  name: string
): ClusterMember {
  return {
    id: t.id,
    name,
    kind: t.kind,
    icon: sceneTileIcon(t),
    color: t.color || null,
  }
}

/** The hover card and the panel over the room. */
export function SummaryMembers3D({
  store,
  tiles,
  nameOf,
  selected,
  onPick,
  onZoom,
}: {
  store: SummaryStore
  tiles: readonly SceneTile[]
  nameOf: (t: SceneTile) => string
  /** The selected tile: never listed - it draws on its own. */
  selected: string | null | undefined
  onPick: (tileId: string) => void
  onZoom: (tileIds: readonly string[]) => void
}) {
  const { hover, open } = useSyncExternalStore(
    store.subscribe,
    store.get,
    store.get
  )
  const byId = useMemo(() => new Map(tiles.map((t) => [t.id, t])), [tiles])
  const member = (id: string) => {
    const t = byId.get(id)
    return t ? sceneTileMember(t, nameOf(t)) : null
  }
  const openMembers = open
    ? clusterMembersOf(open.members, member, [selected])
    : []
  return (
    <>
      {hover && !open && (
        <ClusterHoverCard
          fixed
          at={hover}
          heading={hover.name}
          members={clusterMembersOf(hover.members, member, [selected])}
        />
      )}
      <ClusterMembersPanel
        // A new plate opens fresh: its search cleared.
        key={open?.id ?? "none"}
        fixed
        at={open}
        heading={open?.name ?? ""}
        members={openMembers}
        onPick={(m) => {
          store.open(null)
          onPick(m.id)
        }}
        onZoom={() => {
          const ids = openMembers.map((m) => m.id)
          store.open(null)
          onZoom(ids)
        }}
        onClose={() => store.open(null)}
      />
    </>
  )
}
