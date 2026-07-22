import type { Interface } from "@/lib/api"
import {
  CONNECTOR_MM,
  PANEL_MM,
  SINGLE_ROW_FAMILIES,
  familyForType,
  renderModuleName,
  renderTemplateName,
  type ConnectorFamily,
} from "@/lib/faceplate-geometry"

/**
 * The faceplate layout document — ONE schema for both worlds:
 *  - `autoLayout()` computes it on the fly from a device's interfaces
 *  - the device-type builder saves it to `DeviceType.faceplate` (v1 envelope)
 * so the renderer has exactly one resolution path.
 *
 * Port slots reference components by NAME (interface-template names, which may
 * carry the `{position}` stack token) — never pixel coordinates — so a single
 * saved layout serves every member of a stack and survives bank re-flows.
 */

export type SlotKind =
  | "interface"
  | "console-port"
  | "console-server-port"
  | "power-port"
  | "power-outlet"
  | "front-port"
  | "rear-port"
  | "aux-port"

export type FaceplateSlot =
  | { t: "port"; kind?: SlotKind; name: string }
  | { t: "blank"; family?: ConnectorFamily }
  | { t: "label"; text: string }

export interface FaceplateGroup {
  id: string
  /** Small caption rendered beside the group (slot prefix, "MGMT", …). */
  label?: string
  /** Port rows stacked in the group (column-major fill, odd/first on top).
   * 1U hardware fits 2; taller devices (2U+) fit 3–4. */
  rows: 1 | 2 | 3 | 4
  /** Visual gap every N ports (0 = none). */
  bank: number
  /** Which rack unit of the panel this group sits in (1-based lane, top
   * lane = 1). Multi-U devices place groups per U; default 1. */
  u?: number
  /** Module-bay placeholder: the name of the module bay this group stands in
   * for. On a device render, an installed module's faceplate is composed *in
   * place of* this group; an empty bay draws its blank cage(s). Set on the
   * device type's layout via the builder; absent on ordinary port groups. */
  bay?: string
  slots: FaceplateSlot[]
}

export type FaceplateSide = "front" | "rear"

export interface FaceplateDoc {
  v: 1
  front: FaceplateGroup[]
  /** Rear-panel groups — most types leave this empty. */
  rear: FaceplateGroup[]
  /** Render the full 19″ blade width even when ports don't span it. */
  full?: boolean
}

/** Minimal shape shared by every placeable component (interface, console
 * port, aux port, …) — enough to size and label a cage. */
export interface PortComponent {
  id: string
  name: string
  type?: string
}

export interface ResolvedSlot {
  slot: FaceplateSlot
  family: ConnectorFamily
  kind: SlotKind | null
  /** The matched component, or null (blank / label / ghost). */
  component: PortComponent | null
  /** Full Interface when kind === "interface" — carries live state/hover. */
  iface: Interface | null
  /** Trailing port number for the cage label. */
  num: number | null
}

export interface ResolvedGroup extends FaceplateGroup {
  resolved: ResolvedSlot[]
  /** Rendered width of this group (mm), excluding inter-group gaps. */
  widthMm: number
  /** Tallest connector in the group (mm) — drives row height. */
  rowHeightMm: number
  /** Dominant connector family — drives inter-group dividers. */
  family: ConnectorFamily
}

export interface ResolvedFaceplate {
  groups: ResolvedGroup[]
  /** Total panel span (mm) including group gaps — drives fit-to-container. */
  spanMm: number
}

// ─── helpers (moved from device-faceplate.tsx) ──────────────────────────────

export function portNumber(name: string): number | null {
  const m = name.match(/(\d+)\s*$/)
  return m ? Number(m[1]) : null
}

export function slotPrefix(name: string): string {
  return name.replace(/\d+\s*$/, "")
}

function byPortOrder(a: PortComponent, b: PortComponent): number {
  const an = portNumber(a.name)
  const bn = portNumber(b.name)
  if (an != null && bn != null && an !== bn) return an - bn
  return a.name.localeCompare(b.name, undefined, { numeric: true })
}

// Copper first, then small pluggables, then the big cages — preserves the
// "uplinks to the right" reading of real front panels.
const FAMILY_ORDER: ConnectorFamily[] = [
  "rj45",
  "generic",
  "rj11",
  "sfp",
  "xfp",
  "qsfp",
  "osfp",
  "gbic",
  "x2",
  "cfp2",
  "cfp",
  "antenna",
  "usb-a",
  "usb-b",
  "usb-c",
  "usb-mini",
  "hdmi",
  "displayport",
  "mini-dp",
  "vga",
  "dvi",
  "dsub-9",
  "sd",
  "audio",
]

const familyRank = (f: ConnectorFamily) => {
  const i = FAMILY_ORDER.indexOf(f)
  return i === -1 ? FAMILY_ORDER.length : i
}

// ─── auto layout ────────────────────────────────────────────────────────────

/** Compute a layout doc from a device's physical ports (interfaces only —
 * other component kinds appear on the panel via saved layouts). Groups by
 * slot prefix, splits runs where the connector family changes, sizes rows
 * and banks the way real 1U hardware does. */
export function autoLayout(ports: PortComponent[]): FaceplateDoc {
  // 1. Group by slot prefix (chassis line cards → one group per slot).
  const byPrefix = new Map<string, PortComponent[]>()
  for (const p of ports) {
    const key = slotPrefix(p.name)
    const list = byPrefix.get(key)
    if (list) list.push(p)
    else byPrefix.set(key, [p])
  }

  const groups: { g: FaceplateGroup; fam: ConnectorFamily }[] = []
  for (const [prefix, list] of byPrefix) {
    list.sort(byPortOrder)
    // 2. Split into runs where the family changes (48×SFP28 + 4×QSFP28 under
    //    one prefix → two correctly-sized groups).
    let run: PortComponent[] = []
    let runFamily: ConnectorFamily | null = null
    const flush = () => {
      if (!run.length || runFamily == null) return
      groups.push({
        g: makeAutoGroup(prefix, run, runFamily, groups.length),
        fam: runFamily,
      })
      run = []
    }
    for (const p of list) {
      const fam = familyForType(p.type ?? "")
      if (runFamily !== null && fam !== runFamily) flush()
      runFamily = fam
      run.push(p)
    }
    flush()
  }

  // 3. Copper → small pluggables → big cages, stable within equal ranks.
  groups.sort((a, b) => familyRank(a.fam) - familyRank(b.fam))
  return { v: 1, front: groups.map((x) => x.g), rear: [] }
}

function makeAutoGroup(
  prefix: string,
  run: PortComponent[],
  family: ConnectorFamily,
  index: number
): FaceplateGroup {
  const twoRow = run.length > 12 && !SINGLE_ROW_FAMILIES.has(family)
  return {
    id: `auto-${index}-${prefix || "ports"}`,
    label: prefix || undefined,
    rows: twoRow ? 2 : 1,
    bank: twoRow && run.length >= 24 ? 12 : 0,
    slots: run.map((p) => ({ t: "port", name: p.name })),
  }
}

// ─── module composition ─────────────────────────────────────────────────────

/** An installed module, as the device render needs it to compose faceplates. */
export interface InstalledModuleFaceplate {
  id: string
  module_bay: { name: string; position: string }
  module_type_faceplate: FaceplateDoc | null
  /** The module's concrete contributed interfaces (name + type), used to
   * auto-lay the bay when the module type has no hand-built faceplate. */
  module_interfaces?: { name: string; type?: string }[]
}

/**
 * Compose installed modules into a device's base layout.
 *
 * A group carrying a `bay` marker (a placeholder dropped in the device-type
 * builder) is replaced *in place* by the faceplate of the module installed in
 * that bay, with `{module}` resolved to the bay position. An empty bay — or one
 * whose module has no saved faceplate — keeps its placeholder so the slot stays
 * visible. Modules in bays the layout doesn't place are appended to the front,
 * preserving the behaviour from before bays were placeable.
 */
export function composeModuleFaceplates(
  base: FaceplateDoc,
  modules: InstalledModuleFaceplate[]
): FaceplateDoc {
  if (!modules.length) return base
  const byBay = new Map(modules.map((m) => [m.module_bay.name, m]))
  const placedBays = new Set<string>()
  // `placeholder` is the bay group the module drops into (undefined for a bay
  // the layout doesn't place, which just appends). A hand-built module
  // faceplate is authoritative; without one we auto-lay the module's own
  // interfaces, honoring the placeholder's rows/bank so the operator controls
  // the layout from the bay.
  const expand = (
    m: InstalledModuleFaceplate,
    placeholder?: FaceplateGroup
  ): FaceplateGroup[] => {
    const fp = m.module_type_faceplate
    if (fp) {
      const pos = m.module_bay.position
      return [...fp.front, ...fp.rear].map((g) => ({
        ...g,
        id: `mod:${m.id}:${g.id}`,
        bay: undefined,
        label: g.label ? `${m.module_bay.name} · ${g.label}` : m.module_bay.name,
        slots: g.slots.map((sl) =>
          sl.t === "port" ? { ...sl, name: renderModuleName(sl.name, pos) } : sl
        ),
      }))
    }
    // Module's concrete interfaces (already {module}/{position}-resolved).
    const ifaces = (m.module_interfaces ?? []).map((p, i) => ({
      id: `${m.id}:${i}`,
      name: p.name,
      type: p.type,
    }))
    if (!ifaces.length) return []
    if (placeholder) {
      // One group in the bay's slot, honoring its rows/bank — the operator's
      // layout choice for a module type that ships no faceplate of its own.
      return [
        {
          id: `mod:${m.id}:auto`,
          label: m.module_bay.name,
          rows: placeholder.rows,
          bank: placeholder.bank,
          u: placeholder.u,
          slots: ifaces.map((p) => ({ t: "port", name: p.name })),
        },
      ]
    }
    // Appended (no placeholder) → best-guess auto layout.
    return autoLayout(ifaces).front.map((g, i) => ({
      ...g,
      id: `mod:${m.id}:auto${i}`,
      bay: undefined,
      label: g.label ? `${m.module_bay.name} · ${g.label}` : m.module_bay.name,
    }))
  }
  const compose = (groups: FaceplateGroup[]): FaceplateGroup[] =>
    groups.flatMap((g) => {
      if (!g.bay) return [g]
      placedBays.add(g.bay)
      const m = byBay.get(g.bay)
      const expanded = m ? expand(m, g) : []
      return expanded.length ? expanded : [g]
    })
  const front = compose(base.front)
  const rear = compose(base.rear)
  const leftover = modules
    .filter((m) => !placedBays.has(m.module_bay.name))
    .flatMap((m) => expand(m))
  return { ...base, front: [...front, ...leftover], rear }
}

// ─── resolve (doc + components → renderable) ────────────────────────────────

const norm = (s: string) => s.trim().toLowerCase()

/** Match a layout doc against a device's actual components.
 *
 * - Port slot names are `{position}`-rendered with the device's stack
 *   position, then matched case-insensitively per kind.
 * - Slots matching nothing resolve with `component: null` → dashed ghosts.
 * - Interfaces the doc doesn't cover are appended as trailing auto groups —
 *   nothing silently disappears.
 */
export function resolveLayout(
  doc: FaceplateDoc,
  side: FaceplateSide,
  componentsByKind: Partial<Record<SlotKind, PortComponent[]>>,
  vcPosition: number | null,
  interfaces?: Interface[]
): ResolvedFaceplate {
  const indexes = new Map<SlotKind, Map<string, PortComponent>>()
  for (const [kind, list] of Object.entries(componentsByKind)) {
    indexes.set(
      kind as SlotKind,
      new Map((list ?? []).map((c) => [norm(c.name), c]))
    )
  }
  const ifaceByName = new Map((interfaces ?? []).map((i) => [norm(i.name), i]))

  // Interface names covered ANYWHERE in the doc (both sides) — a port placed
  // on the rear must not re-appear in the front's trailing auto group.
  const claimed = new Set<string>()
  for (const s of ["front", "rear"] as const) {
    for (const g of doc[s] ?? [])
      for (const slot of g.slots)
        if (slot.t === "port" && (slot.kind ?? "interface") === "interface")
          claimed.add(norm(renderTemplateName(slot.name, vcPosition)))
  }

  const resolvedGroups: ResolvedGroup[] = []

  for (const g of doc[side] ?? []) {
    const resolved: ResolvedSlot[] = g.slots.map((slot) => {
      if (slot.t === "label")
        return {
          slot,
          family: "generic",
          kind: null,
          component: null,
          iface: null,
          num: null,
        }
      if (slot.t === "blank")
        return {
          slot,
          family: slot.family ?? "generic", // dominant-family fix-up below
          kind: null,
          component: null,
          iface: null,
          num: null,
        }
      const kind: SlotKind = slot.kind ?? "interface"
      const name = renderTemplateName(slot.name, vcPosition)
      const component = indexes.get(kind)?.get(norm(name)) ?? null
      const iface =
        kind === "interface" ? (ifaceByName.get(norm(name)) ?? null) : null
      const family = familyForType(component?.type ?? "")
      return {
        slot,
        family,
        kind,
        component,
        iface,
        num: portNumber(name),
      }
    })

    // Blanks without an explicit family inherit the group's dominant family.
    const dominant = dominantFamily(resolved)
    for (const r of resolved) {
      if (r.slot.t === "blank" && !r.slot.family) r.family = dominant
    }

    resolvedGroups.push(
      measureGroup(
        // Group labels may carry the {position} token too — render it.
        {
          ...g,
          label: g.label ? renderTemplateName(g.label, vcPosition) : undefined,
        },
        resolved
      )
    )
  }

  // Trailing auto groups (front only) for interfaces the doc doesn't cover.
  const uncovered =
    side === "front"
      ? (componentsByKind.interface ?? []).filter(
          (i) => !claimed.has(norm(i.name))
        )
      : []
  if (uncovered.length) {
    const extra = autoLayout(uncovered)
    for (const g of extra.front) {
      const resolved: ResolvedSlot[] = g.slots.map((slot) => {
        const name = (slot as { t: "port"; name: string }).name
        const component = indexes.get("interface")?.get(norm(name)) ?? null
        return {
          slot,
          family: familyForType(component?.type ?? ""),
          kind: "interface",
          component,
          iface: ifaceByName.get(norm(name)) ?? null,
          num: portNumber(name),
        }
      })
      resolvedGroups.push(measureGroup(g, resolved))
    }
  }

  // Groups spread over U lanes — the panel span is the WIDEST lane, not the
  // sum of every group.
  const laneWidths = new Map<number, { w: number; n: number }>()
  for (const g of resolvedGroups) {
    const lane = g.u ?? 1
    const cur = laneWidths.get(lane) ?? { w: 0, n: 0 }
    laneWidths.set(lane, { w: cur.w + g.widthMm, n: cur.n + 1 })
  }
  const spanMm = Math.max(
    0,
    ...[...laneWidths.values()].map(
      ({ w, n }) => w + Math.max(0, n - 1) * PANEL_MM.groupGap
    )
  )
  return { groups: resolvedGroups, spanMm }
}

function dominantFamily(resolved: ResolvedSlot[]): ConnectorFamily {
  const counts = new Map<ConnectorFamily, number>()
  for (const r of resolved) {
    if (r.slot.t !== "port") continue
    counts.set(r.family, (counts.get(r.family) ?? 0) + 1)
  }
  let best: ConnectorFamily = "generic"
  let n = 0
  for (const [fam, c] of counts)
    if (c > n) {
      best = fam
      n = c
    }
  return best
}

function measureGroup(
  g: FaceplateGroup,
  resolved: ResolvedSlot[]
): ResolvedGroup {
  const portsAndBlanks = resolved.filter((r) => r.slot.t !== "label")
  const columns = Math.ceil(portsAndBlanks.length / g.rows)
  const maxPitch = Math.max(
    0,
    ...portsAndBlanks.map((r) => CONNECTOR_MM[r.family].pitch)
  )
  const rowHeightMm = Math.max(
    0,
    ...portsAndBlanks.map((r) => CONNECTOR_MM[r.family].h)
  )
  const bankCols = g.bank > 0 ? Math.ceil(g.bank / g.rows) : 0
  const bankGaps =
    bankCols > 0 ? Math.max(0, Math.ceil(columns / bankCols) - 1) : 0
  const widthMm = columns * maxPitch + bankGaps * PANEL_MM.bankGap
  return {
    ...g,
    resolved,
    widthMm,
    rowHeightMm,
    family: dominantFamily(resolved),
  }
}
