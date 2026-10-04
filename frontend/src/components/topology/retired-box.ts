import type { StatusMini, TopoNode, TopoPortKind } from "@/lib/api"
import type { PortSide } from "./port-handles"
import type { RetiredStyle } from "./view-document"

// The boxes the retired Wiring and Flat tabs drew their cards at. Their
// renderers are gone; a view arranged on them keeps that arrangement one
// more release, and carrying it into the Diagram centres each card where
// its old card stood (view-document.ts `carryIntoDiagram`) - which needs
// the old card's size. Pure, and removed with the carry-over.

// ── The status pill beside the name ──────────────────────────────────────

/** Longest pill; a longer status name truncated (`max-w-24`). */
const PILL_MAX = 96
/** Horizontal padding plus the badge's 1px border on each side. */
const PILL_PAD = 14
/** 9px medium Inter, a little generous so the estimate never clips. */
const PILL_CHAR_W = 5.2
/** The flex gap between the name and the pill. */
const PILL_GAP = 6

/** What the sizing reads off a node's data. */
export type HasStatusPill = { status_mini?: Pick<StatusMini, "name"> | null }

/** The width a card kept next to its name for the status pill - 0 without
 * one. */
export function statusPillReserve(d: HasStatusPill): number {
  const name = d.status_mini?.name
  if (!name) return 0
  return (
    Math.min(PILL_MAX, PILL_PAD + Math.ceil(name.length * PILL_CHAR_W)) +
    PILL_GAP
  )
}

type NodeData = TopoNode["data"] & HasStatusPill

// ── Wiring ("stencil") cards ─────────────────────────────────────────────
// A card whose cabled ports sit on the sides facing their neighbours, each
// port a cell sized to its full name; past DENSE_PORTS the side columns
// were a faceplate bar of slim slots.

export const CENTER_W = 178
export const CENTER_H = 46
const STRIP_H = 20
const COL_W = 64
const CHIP_W = 58
const ROW_H = 16
const CHAR_W = 5.5
const CELL_PAD = 16
const DENSE_PORTS = 24
const DENSE_PITCH = 16
const DENSE_BAND = 58

type Port = { name: string; kind: TopoPortKind }

/** The identity centre: sized to the name, capped, plus the status pill. */
function centerW(d: NodeData): number {
  return Math.max(
    CENTER_W,
    Math.min(268, 34 + d.name.length * 6.6) + statusPillReserve(d)
  )
}

const chipW = (name: string) =>
  Math.max(CHIP_W, Math.ceil(name.length * CHAR_W) + CELL_PAD)

function colW(ports: Port[]): number {
  let w = COL_W
  for (const p of ports) w = Math.max(w, chipW(p.name))
  return w
}

const stripW = (ports: Port[]) => ports.reduce((s, p) => s + chipW(p.name), 0)

/** Cabled ports, a pass-through pair contributing both its ports. */
function portsOf(d: NodeData): Port[] {
  const out: Port[] = []
  for (const p of d.ports ?? []) {
    out.push({ name: p.name, kind: p.kind })
    if (p.pair) out.push({ name: p.pair, kind: p.kind })
  }
  return out
}

/** A Wiring card's size, its ports on the sides `portSide` gives them
 * (the left by default). */
export function stencilSize(
  d: NodeData & { portSide?: Record<string, PortSide> }
): { width: number; height: number } {
  const all = portsOf(d)
  const s: Record<PortSide, Port[]> = { L: [], R: [], T: [], B: [] }
  for (const p of all) s[d.portSide?.[p.name] ?? "L"].push(p)
  const dense = all.length > DENSE_PORTS
  const band = (side: PortSide) =>
    s[side].length ? (dense ? DENSE_BAND : colW(s[side])) : 0
  const pitch = dense ? DENSE_PITCH : ROW_H
  return {
    width:
      band("L") + band("R") + Math.max(centerW(d), stripW(s.T), stripW(s.B)),
    height:
      (s.T.length ? STRIP_H : 0) +
      (s.B.length ? STRIP_H : 0) +
      Math.max(CENTER_H, s.L.length * pitch, s.R.length * pitch),
  }
}

// ── Flat chips ───────────────────────────────────────────────────────────

export const FLAT_W = 156
export const FLAT_H = 46

/** A Flat chip's width: sized to the name, capped, plus the status pill. */
export function flatW(d: { name?: string } & HasStatusPill): number {
  return Math.max(
    FLAT_W,
    Math.min(250, 40 + (d.name?.length ?? 0) * 6.6) + statusPillReserve(d)
  )
}

/** A card's box on the retired Wiring or Flat tab, which placed cards by
 * their top-left corner. A Wiring card's ports sat on the sides facing
 * their neighbours; here they are split evenly over the two sides of the
 * layout axis, which is near enough to find the card's centre. */
export function retiredBox(
  style: RetiredStyle,
  d: TopoNode["data"] | undefined,
  direction: "LR" | "TB"
): { w: number; h: number } {
  if (style === "flat") return { w: d ? flatW(d) : FLAT_W, h: FLAT_H }
  if (!d) return { w: CENTER_W, h: CENTER_H }
  const sides =
    direction === "TB" ? (["T", "B"] as const) : (["L", "R"] as const)
  const portSide: Record<string, PortSide> = {}
  let i = 0
  for (const p of d.ports ?? [])
    for (const name of p.pair ? [p.name, p.pair] : [p.name])
      portSide[name] = sides[i++ % 2]
  const s = stencilSize({ ...d, portSide })
  return { w: s.width, h: s.height }
}
