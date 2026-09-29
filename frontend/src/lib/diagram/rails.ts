import { readableText } from "@/lib/color"
import type { StatusMini } from "@/lib/api"

import { endTextWidth, pillWidth, PORT_H } from "./geometry"
import { fit, measureText } from "./measure"
import type { Measure, Weight } from "./measure"
import { CARD, cardTextHeight, hex6, LABEL, mix, PILL, PRINT } from "./theme"
import type { Rect } from "./types"

// The rail diagram: full-width colored rails (VLANs, virtual networks)
// grouped into titled sections, and the devices and VMs on them drawn once
// each, as cards in the band under their topmost rail with a leg in the
// rail's color to every rail they attach to. The Logical tab, the Virtual
// topology page and a VM's Topology card all draw from this one layout.
//
// The cards are the Diagram's: the role's color (a neutral card without
// one), the name bold, the status pill in the top-left corner. VMs are
// dashed on screen. Every color comes from data - a rail's VLAN (else its
// zone, else a palette shade by position), a card's role, a pill's status -
// never from a name.

// ── The model: what a surface asks to draw ──────────────────────────────

/** What an item on the diagram opens. */
export type RailTargetKind = "vlan" | "device" | "vm" | "interface" | "vswitch"
export interface RailTarget {
  kind: RailTargetKind
  id: string
}

export interface RailSpec {
  id: string
  /** "name · VLAN 10". */
  label: string
  /** The VLAN's color (else its zone's); none = a palette shade. */
  color?: string | null
  status?: StatusMini | null
  /** Quiet text at the rail's right end (a VM card: the switch). */
  detail?: string
  target?: RailTarget
}

export interface RailAdapterSpec {
  key: string
  /** The host NIC's name. */
  nic: string
  /** The host it is on. */
  host: string
  target?: RailTarget
}

export interface RailSectionSpec {
  id: string
  /** None draws no title row. */
  title?: string
  subtitle?: string
  target?: RailTarget
  /** Host NICs, at the title row's right end. */
  adapters?: RailAdapterSpec[]
  rails: RailSpec[]
}

export interface RailLegSpec {
  /** The rail's id. Legs to a rail not on the diagram are dropped. */
  rail: string
  /** The interface name. */
  label?: string
  /** A tagged (trunk) attachment. */
  dashed?: boolean
  /** Where the label opens. */
  target?: RailTarget
}

export interface RailBoxSpec {
  id: string
  name: string
  /** A virtual machine: dashed on screen. */
  vm?: boolean
  /** The role: its color fills the card. */
  role?: { name: string; color?: string | null } | null
  status?: StatusMini | null
  /** Card lines under the name. */
  lines?: string[]
  target?: RailTarget
  legs: RailLegSpec[]
}

export interface RailModel {
  sections: RailSectionSpec[]
  boxes: RailBoxSpec[]
  /** A full-width bar above everything ("External network"). */
  external?: string
}

// ── Geometry ─────────────────────────────────────────────────────────────

export const RAIL = {
  /** Round the drawing. */
  PAD: 24,
  EXT_H: 30,
  /** Between blocks: the external bar, sections, a title row and its
   * rails. */
  GAP: 16,
  /** A section's title row. */
  STRIP_H: 44,
  TITLE_SIZE: 13,
  TITLE_WEIGHT: 600 as Weight,
  TITLE_LH: 18,
  SUB_SIZE: 10,
  SUB_LH: 14,
  /** A rail. */
  H: 30,
  /** A rail's text inset from its ends. */
  INSET: 12,
  /** Between a rail's name and its pill. */
  PILL_GAP: 8,
  DETAIL_SIZE: 10,
  /** Under a rail with no cards (room for the leg labels above the next). */
  EMPTY_GAP: 22,
  BOX_W: 150,
  BOX_GAP: 22,
  /** Above and below a band's cards: room for the leg labels. */
  BAND_PAD: 18,
  /** The rail names' zone: card columns start after it. */
  RESERVE: 200,
  /** Between the legs of one card. */
  LANE: 6,
  LEG_W: 3,
  /** A tagged leg. */
  DASH: "5 5",
  /** A host NIC's card. */
  ADP_W: 128,
  ADP_GAP: 8,
  MIN_W: 640,
  /** The widest a leg label may run. */
  LABEL_MAX: 160,
} as const

/** Rails with no color of their own: shades of the Danbyte blue, by
 * position. */
export const RAIL_PALETTE = [
  "#1d63ed",
  "#0ea5e9",
  "#1e40af",
  "#38bdf8",
  "#2563eb",
  "#0369a1",
  "#60a5fa",
  "#075985",
] as const

/** A string as drawn: cut to fit (`text`) and whole (`full`) - a tip
 * shows `full` wherever the two differ. */
export interface RailText {
  text: string
  full: string
}

export interface LaidPill extends Rect {
  status: StatusMini
  text: string
}

export interface LaidRail extends Rect {
  id: string
  fill: string
  ink: string
  /** The 1px edge: the fill a step darker. */
  edge: string
  label: RailText
  /** The name's left edge. */
  labelX: number
  labelW: number
  pill?: LaidPill
  /** Right-aligned at `right`. */
  detail?: RailText & { right: number; w: number }
  target?: RailTarget
}

export interface LaidBox extends Rect {
  id: string
  /** The rail it hangs under (index into `rails`). */
  band: number
  /** The role color, or null for the neutral card. */
  fill: string | null
  ink: string | null
  vm: boolean
  name: RailText
  /** The name row's top. */
  titleTop: number
  lines: (RailText & { top: number })[]
  pill?: LaidPill
  role?: { name: string; color?: string | null } | null
  target?: RailTarget
}

export interface LaidLeg {
  key: string
  box: string
  rail: string
  x: number
  /** Top and bottom, y1 < y2. */
  y1: number
  y2: number
  /** It runs up from its card to the rail it hangs under. */
  up: boolean
  color: string
  dashed: boolean
  target?: RailTarget
}

/** The interface names of one card's legs to one rail, beside its legs. */
export interface LaidLegLabel {
  key: string
  box: string
  rail: string
  /** The leg the label belongs to (the first to that rail). */
  leg: string
  x: number
  y: number
  w: number
  h: number
  /** Each name shown, in order; `more` are left out ("+2"). */
  parts: { text: string; target?: RailTarget }[]
  more: number
  /** What is drawn, and all of it for a tip. */
  text: string
  full: string
  /** Even the first name did not fit: `text` is it cut short. */
  clipped: boolean
  /** A clipped label's one target, when it names one interface. */
  target?: RailTarget
}

export interface LaidAdapter extends Rect {
  key: string
  nic: RailText
  host: RailText
  target?: RailTarget
}

export interface LaidStrip {
  id: string
  x: number
  y: number
  w: number
  title: RailText
  subtitle: RailText
  target?: RailTarget
  adapters: LaidAdapter[]
  /** Its first rail (index into `rails`), or -1. */
  firstRail: number
}

export interface RailLayout {
  width: number
  height: number
  external?: Rect & { label: RailText }
  strips: LaidStrip[]
  rails: LaidRail[]
  boxes: LaidBox[]
  legs: LaidLeg[]
  labels: LaidLegLabel[]
  /** Every card's height. */
  boxH: number
  /** The cards keep a row for the pill. */
  pillRow: boolean
}

const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => a + i)

/** Leg labels are measured as end labels are (exact widths). */
const labelW = (s: string, measure: Measure) => endTextWidth(s, measure)

/** Fit one card's names for one rail into `room`: all of them, else as
 * many as fit with a "+N", else the first cut short. */
function fitParts(
  parts: { text: string; target?: RailTarget }[],
  room: number,
  measure: Measure
): Pick<
  LaidLegLabel,
  "parts" | "more" | "text" | "full" | "clipped" | "target"
> {
  const full = parts.map((p) => p.text).join(", ")
  if (labelW(full, measure) <= room)
    return { parts, more: 0, text: full, full, clipped: false }
  for (let k = parts.length - 1; k >= 1; k--) {
    const text =
      parts
        .slice(0, k)
        .map((p) => p.text)
        .join(", ") + ` +${parts.length - k}`
    if (labelW(text, measure) <= room)
      return {
        parts: parts.slice(0, k),
        more: parts.length - k,
        text,
        full,
        clipped: false,
      }
  }
  const text = fit(full, Math.max(0, room), LABEL.END_SIZE, 400, (s, z, w) =>
    measure(s, z, w, true)
  )
  return {
    parts: [],
    more: 0,
    text,
    full,
    clipped: true,
    ...(parts.length === 1 && parts[0].target
      ? { target: parts[0].target }
      : {}),
  }
}

/**
 * Lay a rail model out. `width` is the least width to fill (the screen
 * passes its container's); the drawing grows past it to fit its columns.
 */
export function layoutRails(
  model: RailModel,
  opts: { width?: number; measure?: Measure } = {}
): RailLayout {
  const measure = opts.measure ?? measureText
  const fitText = (s: string, w: number, size: number, weight: Weight) => ({
    text: fit(s, Math.max(0, w), size, weight, measure),
    full: s,
  })

  // 1. Rails in section order.
  const flat: { spec: RailSpec; section: number }[] = []
  model.sections.forEach((s, si) =>
    s.rails.forEach((spec) => flat.push({ spec, section: si }))
  )
  const railIdx = new Map<string, number>()
  flat.forEach((r, i) => {
    if (!railIdx.has(r.spec.id)) railIdx.set(r.spec.id, i)
  })

  // 2. Each card's legs to rails on the diagram, topmost rail first; a
  //    card with none is not drawn.
  const attached = model.boxes
    .map((box) => ({
      box,
      legs: box.legs
        .flatMap((l) => {
          const idx = railIdx.get(l.rail)
          return idx === undefined ? [] : [{ ...l, idx }]
        })
        .sort((a, b) => a.idx - b.idx),
    }))
    .filter((a) => a.legs.length > 0)
    .sort(
      (a, b) =>
        a.legs[0].idx - b.legs[0].idx || a.box.name.localeCompare(b.box.name)
    )

  // 3. Columns: a card holds its column in every band its legs pass
  //    through, so nothing ever overlaps.
  const bandCols = flat.map(() => new Set<number>())
  const placed = attached.map((a) => {
    const first = a.legs[0].idx
    const span = range(first, a.legs[a.legs.length - 1].idx)
    let col = 0
    while (span.some((i) => bandCols[i].has(col))) col++
    span.forEach((i) => bandCols[i].add(col))
    return { ...a, col, band: first }
  })
  const cols = placed.reduce((m, p) => Math.max(m, p.col + 1), 0)
  const pitch = RAIL.BOX_W + RAIL.BOX_GAP
  const width = Math.max(
    2 * RAIL.PAD + RAIL.RESERVE + cols * pitch + pitch / 2,
    RAIL.MIN_W,
    Math.floor(opts.width ?? 0)
  )

  const pillRow = model.boxes.some((b) => !!b.status)
  const nLines = Math.max(0, ...model.boxes.map((b) => b.lines?.length ?? 0))
  const boxH = cardTextHeight(nLines, pillRow)
  const bandH = boxH + 2 * RAIL.BAND_PAD
  const barW = width - 2 * RAIL.PAD

  // 4. Top to bottom: the external bar, then each section's title row and
  //    its rails, each with its band of cards.
  let y = RAIL.PAD
  let external: RailLayout["external"]
  if (model.external) {
    external = {
      x: RAIL.PAD,
      y,
      w: barW,
      h: RAIL.EXT_H,
      label: fitText(
        model.external,
        barW - 2 * RAIL.INSET,
        CARD.TITLE_SIZE,
        CARD.TITLE_WEIGHT
      ),
    }
    y += RAIL.EXT_H + RAIL.GAP
  }
  const strips: LaidStrip[] = []
  const rails: LaidRail[] = []
  const railY: number[] = []
  const bandY: number[] = []
  const adpH = cardTextHeight(1)
  let idx = 0
  model.sections.forEach((sec, si) => {
    if (si > 0) y += RAIL.GAP
    const ups = sec.adapters ?? []
    if (sec.title || ups.length) {
      const adapters = ups.map<LaidAdapter>((u, k) => {
        const x =
          width -
          RAIL.PAD -
          (ups.length - k) * (RAIL.ADP_W + RAIL.ADP_GAP) +
          RAIL.ADP_GAP
        const room = RAIL.ADP_W - 2 * CARD.PAD_X
        return {
          key: u.key,
          x,
          y: y + (RAIL.STRIP_H - adpH) / 2,
          w: RAIL.ADP_W,
          h: adpH,
          nic: fitText(u.nic, room, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT),
          host: fitText(u.host, room, CARD.LINE_SIZE, CARD.LINE_WEIGHT),
          ...(u.target ? { target: u.target } : {}),
        }
      })
      const right = adapters.length
        ? adapters[0].x - RAIL.GAP
        : width - RAIL.PAD
      const room = right - RAIL.PAD
      strips.push({
        id: sec.id,
        x: RAIL.PAD,
        y,
        w: room,
        title: fitText(
          sec.title ?? "",
          room,
          RAIL.TITLE_SIZE,
          RAIL.TITLE_WEIGHT
        ),
        subtitle: fitText(sec.subtitle ?? "", room, RAIL.SUB_SIZE, 400),
        ...(sec.target ? { target: sec.target } : {}),
        adapters,
        firstRail: sec.rails.length ? idx : -1,
      })
      y += RAIL.STRIP_H + RAIL.GAP / 2
    }
    for (const spec of sec.rails) {
      const i = idx++
      const fill = hex6(spec.color) ?? RAIL_PALETTE[i % RAIL_PALETTE.length]
      const ink = hex6(readableText(fill)) ?? PRINT.text
      const pillText = spec.status
        ? fit(
            spec.status.name,
            PILL.MAX_W - 2 * PILL.PAD_X,
            PILL.SIZE,
            PILL.WEIGHT,
            measure
          )
        : ""
      const pw = pillText ? pillWidth(pillText, measure) : 0
      const detail = spec.detail
        ? fitText(spec.detail, barW / 3, RAIL.DETAIL_SIZE, 400)
        : undefined
      const detailW = detail ? measure(detail.text, RAIL.DETAIL_SIZE, 400) : 0
      const room =
        barW -
        2 * RAIL.INSET -
        (pw ? pw + RAIL.PILL_GAP : 0) -
        (detailW ? detailW + 2 * RAIL.INSET : 0)
      const label = fitText(
        spec.label,
        room,
        CARD.TITLE_SIZE,
        CARD.TITLE_WEIGHT
      )
      const lw = measure(label.text, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT)
      const labelX = RAIL.PAD + RAIL.INSET
      rails.push({
        id: spec.id,
        x: RAIL.PAD,
        y,
        w: barW,
        h: RAIL.H,
        fill,
        ink,
        edge: mix("#000000", fill, CARD.EDGE_DARKEN),
        label,
        labelX,
        labelW: lw,
        ...(spec.status && pillText
          ? {
              pill: {
                x: labelX + lw + RAIL.PILL_GAP,
                y: y + (RAIL.H - PILL.H) / 2,
                w: pw,
                h: PILL.H,
                status: spec.status,
                text: pillText,
              },
            }
          : {}),
        ...(detail
          ? {
              detail: {
                ...detail,
                right: RAIL.PAD + barW - RAIL.INSET,
                w: detailW,
              },
            }
          : {}),
        ...(spec.target ? { target: spec.target } : {}),
      })
      railY[i] = y
      y += RAIL.H
      bandY[i] = y
      y += bandCols[i].size > 0 ? bandH : RAIL.EMPTY_GAP
    }
  })

  // 5. The cards, and a leg per attachment in its rail's color - one lane
  //    each, side by side like a ribbon cable.
  const boxes: LaidBox[] = []
  const legs: LaidLeg[] = []
  const pending: (Omit<
    LaidLegLabel,
    "w" | "parts" | "more" | "text" | "full" | "clipped" | "target"
  > & { names: { text: string; target?: RailTarget }[] })[] = []
  const nameRoom = RAIL.BOX_W - 2 * CARD.PAD_X
  for (const p of placed) {
    const stagger = (p.band % 2) * (pitch / 2)
    const bx = RAIL.PAD + RAIL.RESERVE + stagger + p.col * pitch
    const by = bandY[p.band] + RAIL.BAND_PAD
    const cx = bx + RAIL.BOX_W / 2
    const fill = hex6(p.box.role?.color)
    const titleTop = by + CARD.PAD_Y + (pillRow ? PILL.H + PILL.ROW_GAP : 0)
    const pillText = p.box.status
      ? fit(
          p.box.status.name,
          PILL.MAX_W - 2 * PILL.PAD_X,
          PILL.SIZE,
          PILL.WEIGHT,
          measure
        )
      : ""
    boxes.push({
      id: p.box.id,
      band: p.band,
      x: bx,
      y: by,
      w: RAIL.BOX_W,
      h: boxH,
      fill,
      ink: fill ? (hex6(readableText(fill)) ?? PRINT.text) : null,
      vm: !!p.box.vm,
      name: fitText(p.box.name, nameRoom, CARD.TITLE_SIZE, CARD.TITLE_WEIGHT),
      titleTop,
      lines: (p.box.lines ?? []).map((t, k) => ({
        ...fitText(t, nameRoom, CARD.LINE_SIZE, CARD.LINE_WEIGHT),
        top: titleTop + CARD.TITLE_LH + CARD.LINES_GAP + k * CARD.LINE_LH,
      })),
      ...(p.box.status && pillText
        ? {
            pill: {
              x: bx + PILL.X,
              y: by + CARD.PAD_Y,
              w: pillWidth(pillText, measure),
              h: PILL.H,
              status: p.box.status,
              text: pillText,
            },
          }
        : {}),
      role: p.box.role ?? null,
      ...(p.box.target ? { target: p.box.target } : {}),
    })

    const n = p.legs.length
    const laneX = (k: number) => cx + (k - (n - 1) / 2) * RAIL.LANE
    // The legs up to the rail the card hangs under come first (they are
    // sorted by rail): only they cross the gap between that rail and the
    // card; below the card, every leg down does.
    const nUp = p.legs.filter((l) => l.idx === p.band).length
    const rightOf = (k: number) => laneX(k) + RAIL.LEG_W / 2
    const groups = new Map<number, { leg: string; names: typeof p.legs }>()
    p.legs.forEach((leg, k) => {
      const up = leg.idx === p.band
      const key = `${p.box.id}|${k}`
      legs.push({
        key,
        box: p.box.id,
        rail: rails[leg.idx].id,
        x: laneX(k),
        y1: up ? railY[leg.idx] + RAIL.H : by + boxH,
        y2: up ? by : railY[leg.idx],
        up,
        color: rails[leg.idx].fill,
        dashed: !!leg.dashed,
        ...(leg.target ? { target: leg.target } : {}),
      })
      const g = groups.get(leg.idx)
      if (g) g.names.push(leg)
      else groups.set(leg.idx, { leg: key, names: [leg] })
    })
    for (const [ri, g] of groups) {
      const seen = new Set<string>()
      const names = g.names.flatMap((l) => {
        const text = l.label ?? ""
        const k = `${text}\u0000${l.target?.id ?? ""}`
        if (!text || seen.has(k)) return []
        seen.add(k)
        return [{ text, ...(l.target ? { target: l.target } : {}) }]
      })
      if (!names.length) continue
      // Between a card and the rail it hangs under, or just above a rail
      // further down: clear of the rails and the cards.
      const mid =
        ri === p.band ? by - RAIL.BAND_PAD / 2 : railY[ri] - RAIL.BAND_PAD / 2
      pending.push({
        key: `${p.box.id}|r${ri}`,
        box: p.box.id,
        rail: rails[ri].id,
        leg: g.leg,
        x: rightOf(ri === p.band ? nUp - 1 : n - 1) + LABEL.GAP + 1,
        y: mid - PORT_H / 2,
        h: PORT_H,
        names,
      })
    }
  }

  // 6. Each label runs right as far as the next leg or card at its height.
  const labels: LaidLegLabel[] = pending.map(({ names, ...lab }) => {
    const top = lab.y
    const bottom = lab.y + lab.h
    let limit = Math.min(width - RAIL.PAD, lab.x + RAIL.LABEL_MAX)
    for (const l of legs) {
      const left = l.x - RAIL.LEG_W / 2
      if (left > lab.x && l.y1 < bottom && l.y2 > top)
        limit = Math.min(limit, left - LABEL.GAP)
    }
    for (const b of boxes)
      if (b.x > lab.x && b.y < bottom && b.y + b.h > top)
        limit = Math.min(limit, b.x - LABEL.GAP)
    const fitted = fitParts(names, limit - lab.x, measure)
    return { ...lab, ...fitted, w: labelW(fitted.text, measure) }
  })

  return {
    width,
    height: y + RAIL.PAD,
    ...(external ? { external } : {}),
    strips,
    rails,
    boxes,
    legs,
    labels,
    boxH,
    pillRow,
  }
}

/** The roles on the cards, in first-seen order - the legend's badges. */
export function railRoles(
  model: RailModel
): { name: string; color?: string }[] {
  const seen = new Map<string, string | undefined>()
  for (const b of model.boxes)
    if (b.role && !seen.has(b.role.name))
      seen.set(b.role.name, b.role.color || undefined)
  return [...seen].map(([name, color]) => ({ name, color }))
}
