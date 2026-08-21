import { Handle, Position, type NodeProps } from "@xyflow/react"

import type { TopoNode, TopoPortKind } from "@/lib/api"

// ── Handle-id side suffixes ──────────────────────────────────────────────────
// A port renders on exactly one side of its card (the side facing its
// neighbour, chosen in the canvas from geometry). Its handle id is the port
// name plus a side suffix; the edge references the same id. Left is the bare
// name so handle-less edges still resolve.
export const RIGHT = "~r"
export const ABOVE = "~t"
export const BELOW = "~b"

export type PortSide = "L" | "R" | "T" | "B"

export function handleId(name: string, side: PortSide): string {
  return side === "L"
    ? name
    : side === "R"
      ? name + RIGHT
      : side === "T"
        ? name + ABOVE
        : name + BELOW
}

export type StencilData = TopoNode["data"] & {
  /** Search miss → render faded. */
  dimmed?: boolean
  /** Port name → the card edge it renders on (computed in the canvas from
   * the laid-out geometry, so a port faces its neighbour). Absent → default
   * split used for the first (nominal) layout pass. */
  portSide?: Record<string, PortSide>
  /** Port name → sort key (the neighbour's cross-axis position). Ports on a
   * side render in this order, so edges leave in the same order as their
   * targets and don't cross. */
  portOrder?: Record<string, number>
}

// Sizing - dagre reserves these; the DOM must match so handles land right.
export const CENTER_W = 178
export const CENTER_H = 46
// The device name is the most important text on the map - the identity
// centre widens to fit it (11px mono ≈ 6.6px/char + spine/padding), capped
// so one hostname can't blow up a card.
function centerW(d: StencilData): number {
  return Math.max(
    CENTER_W,
    Math.min(268, 34 + (d.name?.length ?? 0) * 6.6)
  )
}
const STRIP_H = 20 // top / bottom horizontal strip
const COL_W = 64 // left / right vertical column MINIMUM
const CHIP_W = 58 // one port in a horizontal strip MINIMUM
const ROW_H = 16 // one port in a vertical column
export const STENCIL_FOOTER = 14

// Port names render in full (no truncation) - cells size to their text.
// 9px monospace ≈ 5.5px/char; padding = px-1.5 (12) + slack.
const CHAR_W = 5.5
const CELL_PAD = 16
function chipW(name: string): number {
  return Math.max(CHIP_W, Math.ceil(name.length * CHAR_W) + CELL_PAD)
}
function colWFor(ports: FlatPort[]): number {
  let w = COL_W
  for (const p of ports) w = Math.max(w, chipW(p.name))
  return w
}

const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-500",
  planned: "bg-amber-500",
  staged: "bg-amber-500",
  failed: "bg-red-500",
  offline: "bg-red-500",
  decommissioning: "bg-zinc-400",
}

type FlatPort = { name: string; kind: TopoPortKind }

/** Cabled ports flattened - a pass-through pair contributes both its ports. */
function flatPorts(d: StencilData): FlatPort[] {
  const out: FlatPort[] = []
  for (const p of d.ports ?? []) {
    out.push({ name: p.name, kind: p.kind })
    if (p.pair) out.push({ name: p.pair, kind: p.kind })
  }
  return out
}

/** Split ports by their assigned side; unassigned default to L (first pass).
 * Each side is then ordered by the neighbour's cross-axis position so edges
 * on that side leave in the same order as their targets - no crossings. */
function bySide(d: StencilData) {
  const sides: Record<PortSide, FlatPort[]> = { L: [], R: [], T: [], B: [] }
  for (const fp of flatPorts(d)) {
    sides[d.portSide?.[fp.name] ?? "L"].push(fp)
  }
  const order = d.portOrder
  if (order) {
    for (const side of ["L", "R", "T", "B"] as PortSide[]) {
      sides[side].sort((a, b) => (order[a.name] ?? 0) - (order[b.name] ?? 0))
    }
  }
  return sides
}

/** Card w/h from the per-side port counts. Strips size to their own ports,
 * so a device with three uplinks on top and one downlink on bottom gets a
 * wide top strip and a narrow bottom one. */
/** Sum of the chip widths on a horizontal strip (top/bottom) - each chip sizes
 * to its own full port name, so the strip is as wide as its labels need. */
function stripW(ports: FlatPort[]): number {
  return ports.reduce((sum, p) => sum + chipW(p.name), 0)
}

// ── Dense cards: the faceplate bar ──────────────────────────────────────────
// Above this many cabled ports the side COLUMNS stop sizing every row to its
// full port name and render as a switch faceplate instead: 16px slots with
// truncated names, so a 48-port stack doesn't grow a card taller than the
// screen. Top and bottom strips always keep full horizontal names - that is
// the axis with room for them.
export const DENSE_PORTS = 24
const DENSE_PITCH = 16 // one port slot
const DENSE_BAND = 58 // side-band depth (truncated names)

function isDense(d: StencilData): boolean {
  return flatPorts(d).length > DENSE_PORTS
}

export function stencilSize(d: StencilData): { width: number; height: number } {
  const s = bySide(d)
  const hasL = s.L.length > 0
  const hasR = s.R.length > 0
  const hasT = s.T.length > 0
  const hasB = s.B.length > 0
  if (isDense(d)) {
    const lW = hasL ? DENSE_BAND : 0
    const rW = hasR ? DENSE_BAND : 0
    const width = lW + rW + Math.max(centerW(d), stripW(s.T), stripW(s.B))
    const height =
      (hasT ? STRIP_H : 0) +
      (hasB ? STRIP_H : 0) +
      Math.max(CENTER_H, s.L.length * DENSE_PITCH, s.R.length * DENSE_PITCH)
    return { width, height }
  }
  const lW = hasL ? colWFor(s.L) : 0
  const rW = hasR ? colWFor(s.R) : 0
  const width =
    lW +
    rW +
    Math.max(centerW(d), stripW(s.T), stripW(s.B))
  const height =
    (hasT ? STRIP_H : 0) +
    (hasB ? STRIP_H : 0) +
    Math.max(CENTER_H, s.L.length * ROW_H, s.R.length * ROW_H)
  return { width, height }
}

// topo-conn: the connector dot. Styled in styles.css so it sits fully OUTSIDE
// the card edge - a whole circle where the cable starts, never a half dot
// clipped by the cell border.
const HANDLE = "topo-conn"
const POS: Record<PortSide, Position> = {
  L: Position.Left,
  R: Position.Right,
  T: Position.Top,
  B: Position.Bottom,
}

function PortCell({
  port,
  side,
  vertical,
}: {
  port: FlatPort
  side: PortSide
  vertical: boolean
}) {
  const id = handleId(port.name, side)
  return (
    <div
      className={
        "relative flex items-center gap-1 px-1.5 " +
        (vertical ? "" : "justify-center")
      }
      style={
        vertical
          ? { height: ROW_H }
          : { height: STRIP_H, width: chipW(port.name) }
      }
    >
      <Handle type="target" id={id} position={POS[side]} className={HANDLE} />
      <Handle type="source" id={id} position={POS[side]} className={HANDLE} />
      {/* topo-portname is a LOD hook: far zoom hides the text via CSS
          (visibility) while the cell geometry - and the edge handles on
          it - stays exactly where it was. */}
      {/* Full port name - no truncation; cells are sized to fit it. */}
      <span className="topo-portname font-mono text-[9px] leading-none whitespace-nowrap">
        {port.name}
      </span>
    </div>
  )
}

/** Faceplate slot: a 16px row on a side column, name truncated to the band. */
function DensePort({ port, side }: { port: FlatPort; side: PortSide }) {
  const id = handleId(port.name, side)
  return (
    <div
      className={
        "relative flex items-center pr-1 pl-1 " +
        (side === "L" ? "justify-end" : "justify-start")
      }
      style={{ height: DENSE_PITCH, width: DENSE_BAND }}
      title={port.name}
    >
      <Handle type="target" id={id} position={POS[side]} className={HANDLE} />
      <Handle type="source" id={id} position={POS[side]} className={HANDLE} />
      <span className="topo-portname min-w-0 truncate font-mono text-[8px] leading-none text-muted-foreground">
        {port.name}
      </span>
    </div>
  )
}

/**
 * Adaptive wiring-diagram device card. Each cabled port renders **once**, on
 * whichever of the four card edges faces its neighbour - so HA links between
 * two side-by-side devices connect on their touching sides, uplinks sit on
 * top, downlinks on the bottom, and nothing wraps around the card. The strips
 * auto-size to their own port counts. One node serves both the side-to-side
 * and tree layouts (only the rank axis differs).
 */
export function StencilNode({ data, selected }: NodeProps) {
  const d = data as StencilData
  const s = bySide(d)
  const total = flatPorts(d).length
  const extra = (d.interface_count ?? 0) - total
  const dense = isDense(d)
  const hasL = s.L.length > 0
  const hasR = s.R.length > 0
  const hasT = s.T.length > 0
  const hasB = s.B.length > 0
  const { width } = stencilSize(d)
  // Side columns size to their widest full port name (matches stencilSize, so
  // dagre's reserved box and the DOM agree and handles land correctly).
  const lW = hasL ? (dense ? DENSE_BAND : colWFor(s.L)) : 0
  const rW = hasR ? (dense ? DENSE_BAND : colWFor(s.R)) : 0

  const ring = selected
    ? "border-primary ring-2 ring-primary/30"
    : d.panel
      ? "border-dashed border-border"
      : "border-border"

  return (
    <div
      className={`grid rounded-lg border bg-card transition-opacity ${ring} ${
        d.dimmed ? "opacity-30" : ""
      }`}
      style={{
        width,
        gridTemplateColumns: `${lW}px minmax(0,1fr) ${rW}px`,
        gridTemplateRows: `${hasT ? STRIP_H : 0}px minmax(0,1fr) ${hasB ? STRIP_H : 0}px`,
      }}
    >
      {/* Whole-card fallbacks for edges with no port handle (LLDP ghosts). */}
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-border opacity-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-border opacity-0"
      />

      {/* Top strip */}
      {hasT && (
        <div
          className="col-start-2 row-start-1 flex divide-x divide-border border-b border-border"
        >
          {s.T.map((p) => (
            <PortCell key={"T" + p.name} port={p} side="T" vertical={false} />
          ))}
        </div>
      )}
      {/* Left column */}
      {hasL && (
        <div
          className="col-start-1 row-start-2 flex flex-col justify-center divide-y divide-border border-r border-border"
        >
          {s.L.map((p) =>
            dense ? (
              <DensePort key={"L" + p.name} port={p} side="L" />
            ) : (
              <PortCell key={"L" + p.name} port={p} side="L" vertical />
            )
          )}
        </div>
      )}

      {/* Center identity */}
      <div
        className="col-start-2 row-start-2 flex items-center gap-1.5 px-2"
        style={{ minHeight: CENTER_H }}
      >
        <span
          className="h-6 w-1 shrink-0 rounded-full"
          style={{ background: d.role?.color || "var(--border)" }}
          title={d.role?.name}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            {d.status && (
              <span
                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                  STATUS_DOT[d.status] ?? "bg-zinc-400"
                }`}
                title={d.status_display || d.status}
              />
            )}
            <span className="truncate font-mono text-[11px] font-medium">
              {d.name}
            </span>
          </div>
          <div className="truncate text-[9px] text-muted-foreground">
            {d.panel
              ? "patch panel"
              : [d.device_type, d.primary_ip].filter(Boolean).join(" · ") ||
                d.site ||
                "-"}
          </div>
          {(dense || extra > 0) && (
            <div className="text-[9px] text-muted-foreground">
              {dense ? `${total} cabled` : ""}
              {dense && extra > 0 ? " · " : ""}
              {extra > 0 ? `+${extra} uncabled` : ""}
            </div>
          )}
        </div>
      </div>

      {/* Right column */}
      {hasR && (
        <div
          className="col-start-3 row-start-2 flex flex-col justify-center divide-y divide-border border-l border-border"
        >
          {s.R.map((p) =>
            dense ? (
              <DensePort key={"R" + p.name} port={p} side="R" />
            ) : (
              <PortCell key={"R" + p.name} port={p} side="R" vertical />
            )
          )}
        </div>
      )}
      {/* Bottom strip */}
      {hasB && (
        <div
          className="col-start-2 row-start-3 flex divide-x divide-border border-t border-border"
        >
          {s.B.map((p) => (
            <PortCell key={"B" + p.name} port={p} side="B" vertical={false} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Small pill for port-level trace nodes (interface / front / rear port on
 * the cable-trace views) - the stencil card is for devices. */
export function PortNode({ data, selected }: NodeProps) {
  const d = data as {
    name: string
    kind?: string
    device_name?: string
    is_splitter?: boolean
  }
  return (
    <div
      className={`rounded-md border bg-card px-2.5 py-1.5 ${
        selected ? "border-primary ring-2 ring-primary/30" : "border-border"
      }`}
    >
      <div className="flex items-center gap-1.5 font-mono text-[11px] font-medium">
        {d.name}
        {d.is_splitter && (
          <span className="rounded-sm bg-violet-500/15 px-1 font-sans text-[9px] font-medium text-violet-600 dark:text-violet-400">
            splitter
          </span>
        )}
      </div>
      <div className="text-[10px] text-muted-foreground">
        {d.device_name}
        {d.kind ? ` · ${d.kind.replace("_", " ")}` : ""}
      </div>
      <Handle
        type="target"
        position={Position.Left}
        className="!h-1.5 !w-1.5 !border-0 !bg-border opacity-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        className="!h-1.5 !w-1.5 !border-0 !bg-border opacity-0"
      />
    </div>
  )
}
