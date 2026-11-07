import { naturalCompare } from "@/lib/natural-sort"

// What a cluster holds, as its hover and its panel list it - the 2D plan's
// icon clusters and the 3D room's summary plates alike: each member by
// name with its kind's icon, grouped by kind when the kinds are mixed.

/** One member of a cluster, as listed. */
export interface ClusterMember {
  id: string
  name: string
  /** rack, cabinet, device, or anything else. */
  kind: string
  /** Its icon (object-icon.ts) and colour, as its tile wears them. */
  icon: string
  color?: string | null
}

export interface ClusterMemberGroup {
  kind: string
  /** "Racks", "Devices"; "" when the cluster is all of one kind. */
  label: string
  members: ClusterMember[]
}

/** The hover lists at most this many; the panel searches past it. */
export const CLUSTER_LIST_CAP = 12

const KIND_ORDER = ["rack", "cabinet", "device"]
const KIND_LABEL: Record<string, string> = {
  rack: "Racks",
  cabinet: "Cabinets",
  device: "Devices",
}

/** The members a cluster lists: its ids that still resolve, but the
 * selected one - a selected object leaves its cluster and draws on its
 * own. */
export function clusterMembersOf(
  ids: readonly string[],
  byId: (id: string) => ClusterMember | null | undefined,
  selected?: readonly (string | null | undefined)[]
): ClusterMember[] {
  const out = new Set(selected?.filter(Boolean) as string[] | undefined)
  const list: ClusterMember[] = []
  for (const id of ids) {
    if (out.has(id)) continue
    const m = byId(id)
    if (m) list.push(m)
  }
  return list
}

/** Members matching a search (name, case-insensitive). */
export function filterClusterMembers(
  members: readonly ClusterMember[],
  query: string
): ClusterMember[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...members]
  return members.filter((m) => m.name.toLowerCase().includes(q))
}

/**
 * The members by kind - racks, cabinets, devices, then the rest - each in
 * natural name order; one unlabelled group when all are of one kind. With
 * `cap`, only the first `cap` across the groups, and `more` counts the
 * rest.
 */
export function groupClusterMembers(
  members: readonly ClusterMember[],
  cap = Infinity
): { groups: ClusterMemberGroup[]; more: number } {
  const byKind = new Map<string, ClusterMember[]>()
  for (const m of members) {
    const k = KIND_ORDER.includes(m.kind) ? m.kind : "other"
    const l = byKind.get(k)
    if (l) l.push(m)
    else byKind.set(k, [m])
  }
  const kinds = [...KIND_ORDER, "other"].filter((k) => byKind.has(k))
  const mixed = kinds.length > 1
  let left = cap
  const groups: ClusterMemberGroup[] = []
  for (const kind of kinds) {
    if (left <= 0) break
    const sorted = byKind
      .get(kind)!
      .sort((a, b) => naturalCompare(a.name, b.name))
    const take = sorted.slice(0, left)
    left -= take.length
    groups.push({
      kind,
      label: mixed ? (KIND_LABEL[kind] ?? "Other") : "",
      members: take,
    })
  }
  const shown = groups.reduce((n, g) => n + g.members.length, 0)
  return { groups, more: members.length - shown }
}
