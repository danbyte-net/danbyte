import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Waypoints } from "lucide-react"

import { api } from "@/lib/api"
import type { TraceGraph } from "@/lib/api"
import { isFiberType } from "@/lib/fiber"
import type { FiberColorEntry } from "@/lib/fiber"
import { FiberDot } from "@/components/fiber/fiber-dot"
import { useFiberPalette } from "@/components/fiber/use-fiber-palette"

/** The fibre cable's strands as a compact row of coloured dots (the same
 * swatch used on the cable page, tracer stripes and all), capped at 12 with a
 * ×N count — so a trunk reads as "12 fibres" right in the trace. */
function StrandStrip({
  count,
  palette,
}: {
  count: number
  palette: FiberColorEntry[]
}) {
  const shown = Math.min(count, 12)
  return (
    <span className="inline-flex items-center gap-1">
      <span className="flex gap-px">
        {Array.from({ length: shown }, (_, i) => (
          <FiberDot
            key={i}
            position={i + 1}
            palette={palette}
            size={8}
            showTracer
          />
        ))}
      </span>
      <span className="num font-medium text-foreground">×{count}</span>
    </span>
  )
}

/** A fibre segment marker: two parallel strokes = a duplex fibre. Tinted with
 * the strand colour when a strand is threaded, else inherits the label colour.
 * Makes "this hop is fibre" legible even when the cable has no colour set. */
function FiberGlyph({ color }: { color?: string }) {
  return (
    <svg
      width="11"
      height="7"
      viewBox="0 0 11 7"
      className="shrink-0"
      style={color ? { color } : undefined}
      aria-hidden="true"
    >
      <path
        d="M1 2h9M1 5h9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}

/** Estimate how wide a segment must be so its floating label/tag don't collide
 * with neighbours. Labels are absolutely positioned (to sit the wire on the row
 * midline), so they don't grow the box on their own — hence this heuristic from
 * the text length at the label (9px) and tag (8px) sizes. */
function estSegWidth(seg: PathSegment): number {
  const glyph = seg.fiber && !seg.fiberCount ? 15 : 0
  const label = seg.label.length * 5.3 + glyph + 8
  const strandTxt = seg.strand ? `strand ${seg.strand}`.length * 5 + 16 : 0
  const strip =
    !seg.strand && seg.fiber && seg.fiberCount
      ? Math.min(seg.fiberCount, 12) * 9 + 28
      : 0
  const tag = (seg.tag?.length ?? 0) * 4.8
  const self = seg.self ? 46 : 0
  const bottom = strandTxt + strip + tag + self
  return Math.max(48, label, bottom + (bottom ? 6 : 0))
}

/** One device the path passes through, with the port(s) it used. Interface
 * ports carry their id — the rendered name becomes a quiet click target. */
export type PathChip = {
  deviceId?: string
  device: string
  ports: { name: string; interfaceId?: string }[]
  /** The device whose page this trace is on — bordered as "you are here". */
  origin?: boolean
}
export type PathSegment = {
  cableId?: string
  label: string
  /** The physical tag printed on the cable, shown under the line. */
  tag?: string
  color?: string
  self: boolean
  /** This segment is an optical-fibre cable. */
  fiber?: boolean
  /** How many strands the fibre cable carries (for the ×N badge). */
  fiberCount?: number | null
  /** On a fibre trunk, the strand this run threads through + its colour. */
  strand?: number
  strandColor?: { name: string; hex: string }
}

export type PathStep =
  | { t: "chip"; chip: PathChip }
  | { t: "seg"; seg: PathSegment }

/** The flat run itself — linked device/panel chips joined by cable segments
 * drawn in their physical color. Shared by the cable page hero and the
 * device page's Paths view. */
export function PathStrip({
  steps,
  highlightPort,
  leading,
  onTraceCable,
}: {
  steps: PathStep[]
  /** Port name to emphasise (e.g. the traced origin on a mid-chain device). */
  highlightPort?: string
  /** Rendered as the first flex item INSIDE the scroll container — an origin
   * label + leader line scrolls (and centers) with the strip, never apart
   * from it. */
  leading?: React.ReactNode
  /** When set (floor-plan deep-view), each cable segment gets a "trace on
   * map" button that highlights that cable's route on the plan. */
  onTraceCable?: (cableId: string) => void
}) {
  const navigate = useNavigate()
  const palette = useFiberPalette()
  return (
    // Symmetric padding: the floating labels need headroom (the scroll
    // container clips vertical overflow), and equal top/bottom keeps the
    // content midline on the box midline — level with the leader line.
    <div className="flex items-center overflow-x-auto py-4">
      {leading}
      {steps.map((s, i) =>
        s.t === "chip" ? (
          // NetBox's termination boxes, rotated horizontal: device name on
          // top, then one divided cell per port the run touches — entry on
          // the left (where the line comes in), exit on the right.
          <div
            key={i}
            className={
              "shrink-0 overflow-hidden rounded-md border bg-card " +
              (s.chip.origin
                ? "border-primary ring-1 ring-primary/40"
                : "border-border")
            }
          >
            {s.chip.deviceId ? (
              <Link
                to="/devices/$id"
                params={{ id: s.chip.deviceId }}
                className="block px-2.5 pt-1.5 pb-1 text-[11px] font-medium whitespace-nowrap hover:underline"
              >
                {s.chip.device}
              </Link>
            ) : (
              <div className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium whitespace-nowrap">
                {s.chip.device}
              </div>
            )}
            <div className="flex divide-x divide-border border-t border-border">
              {s.chip.ports.map((port, pi) => {
                // Interfaces open their own page; other ports (front/rear/
                // console/power) open their device's Hardware tab.
                const onClick = port.interfaceId
                  ? () =>
                      navigate({
                        to: "/interfaces/$id",
                        params: { id: port.interfaceId! },
                      })
                  : s.chip.deviceId
                    ? () =>
                        navigate({
                          to: "/devices/$id",
                          params: { id: s.chip.deviceId! },
                          search: { tab: "components" },
                        })
                    : undefined
                return (
                  <span
                    key={pi}
                    className={
                      "flex-1 px-2 py-0.5 text-center font-mono text-[10px] whitespace-nowrap " +
                      (highlightPort && port.name === highlightPort
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground") +
                      (onClick ? " cursor-pointer hover:text-foreground" : "")
                    }
                    onClick={onClick}
                    title={
                      port.interfaceId
                        ? "Open interface"
                        : onClick
                          ? "Open in Hardware"
                          : undefined
                    }
                  >
                    {port.name}
                  </span>
                )
              })}
            </div>
          </div>
        ) : (
          // The line is the segment's only in-flow child, so flex centering
          // puts the stroke on the row's exact midline (level with the
          // leader line and the chips' centers); the label floats above it.
          <div
            key={i}
            className="relative shrink-0"
            style={{ minWidth: estSegWidth(s.seg) }}
          >
            <span
              className={
                "absolute bottom-full left-1/2 mb-0.5 flex -translate-x-1/2 items-center gap-1 text-[9px] whitespace-nowrap " +
                (s.seg.self
                  ? "font-medium text-foreground"
                  : "text-muted-foreground")
              }
            >
              {s.seg.fiber && !s.seg.fiberCount && (
                <FiberGlyph color={s.seg.strandColor?.hex} />
              )}
              {s.seg.cableId && !s.seg.self ? (
                <Link
                  to="/cables/$id"
                  params={{ id: s.seg.cableId }}
                  className="hover:underline"
                >
                  {s.seg.label}
                </Link>
              ) : (
                s.seg.label
              )}
            </span>
            <span
              className="block w-full rounded-full"
              style={{
                height: s.seg.fiber ? 3 : 2,
                background:
                  s.seg.strandColor?.hex || s.seg.color || "var(--border)",
                minWidth: 48,
                // A fibre cable (no single strand) reads as a thin duplex rail;
                // a threaded strand is a single line in its own colour.
                boxShadow:
                  s.seg.fiber && !s.seg.strand
                    ? `0 3px 0 -1.5px ${s.seg.color || "var(--border)"}`
                    : undefined,
              }}
            />
            {(s.seg.self ||
              s.seg.tag ||
              s.seg.strand ||
              (s.seg.fiber && s.seg.fiberCount) ||
              (onTraceCable && s.seg.cableId)) && (
              <span className="absolute top-full left-1/2 mt-0.5 flex -translate-x-1/2 items-center gap-1 text-[8px] whitespace-nowrap text-muted-foreground">
                {s.seg.strand ? (
                  <span
                    className="inline-flex items-center gap-1 font-medium text-foreground"
                    title={
                      "Strand " + s.seg.strand + " · " + s.seg.strandColor?.name
                    }
                  >
                    <FiberDot
                      position={s.seg.strand}
                      palette={palette}
                      size={11}
                      showTracer
                    />
                    strand {s.seg.strand}
                  </span>
                ) : s.seg.fiber && s.seg.fiberCount ? (
                  <StrandStrip count={s.seg.fiberCount} palette={palette} />
                ) : null}
                {(s.seg.strand || (s.seg.fiber && s.seg.fiberCount)) &&
                  (s.seg.tag || s.seg.self) &&
                  " · "}
                {s.seg.tag && <span className="font-mono">{s.seg.tag}</span>}
                {s.seg.tag && s.seg.self && " · "}
                {s.seg.self && "this cable"}
                {onTraceCable && s.seg.cableId ? (
                  <button
                    type="button"
                    title="Trace this cable on the floor plan"
                    onClick={() => onTraceCable(s.seg.cableId as string)}
                    className="shrink-0 hover:text-foreground"
                  >
                    <Waypoints className="h-3 w-3" />
                  </button>
                ) : null}
              </span>
            )}
          </div>
        )
      )}
    </div>
  )
}

/** Flatten a cable's trace graph into chip ─cable─ chip …, when the trace is
 * a simple path. Returns null for breakouts/loops — the Trace tab handles
 * those. */
export function portOf(n: { id: string; data: { name: string } }): {
  name: string
  interfaceId?: string
} {
  return n.id.startsWith("if:")
    ? { name: n.data.name, interfaceId: n.id.slice(3) }
    : { name: n.data.name }
}

type TraceEdge = TraceGraph["edges"][number]
type Adj = { other: string; edge: TraceEdge }
type SeqItem = { nodeId: string; edge?: TraceEdge }

/** Wire-graph adjacency (cable + through edges only). */
function wireAdj(g: TraceGraph): Map<string, Adj[]> {
  const adj = new Map<string, Adj[]>()
  for (const e of g.edges) {
    if (e.type !== "cable" && e.type !== "through") continue
    adj.set(e.source, [
      ...(adj.get(e.source) ?? []),
      { other: e.target, edge: e },
    ])
    adj.set(e.target, [
      ...(adj.get(e.target) ?? []),
      { other: e.source, edge: e },
    ])
  }
  return adj
}

/** Turn a node sequence (leaf→…) into chip ─cable─ chip steps: consecutive
 * ports on the same device group into one chip, cables become segments. */
function buildSteps(
  seq: SeqItem[],
  nodeById: Map<string, TraceGraph["nodes"][number]>,
  selfCableId: string
): PathStep[] | null {
  const steps: PathStep[] = []
  let chip: PathChip | null = null
  for (const { nodeId, edge } of seq) {
    const n = nodeById.get(nodeId)
    if (!n) return null
    const dev = n.data.device_name ?? "?"
    const devId = n.data.device_id
    if (edge?.type === "cable" || chip === null) {
      if (edge?.type === "cable") {
        const d = edge.data ?? {}
        steps.push({
          t: "seg",
          seg: {
            cableId: d.cable_id,
            label: d.cable_type || "cable",
            tag: (d as { cable_label?: string }).cable_label || undefined,
            color: d.color || undefined,
            self: d.cable_id === selfCableId,
            fiber: isFiberType(d.cable_type || ""),
            fiberCount: (d as { fiber_count?: number | null }).fiber_count,
          },
        })
        chip = null
      }
      if (chip === null) {
        chip = { deviceId: devId, device: dev, ports: [portOf(n)] }
        steps.push({ t: "chip", chip })
        continue
      }
    }
    // through-edge hop: same device, extend the chip.
    if (chip && chip.deviceId === devId) chip.ports.push(portOf(n))
    else return null
  }
  return steps
}

/** Walk a linear chain from `start` away from `from` to its leaf/branch. */
function walkChain(
  start: string,
  from: string | null,
  adj: Map<string, Adj[]>,
  stopAt?: string
): SeqItem[] {
  const seq: SeqItem[] = [{ nodeId: start }]
  const visited = new Set<string>([start])
  let prev = from
  let cur = start
  for (let i = 0; i < 500; i++) {
    if (cur === stopAt && i > 0) break
    const next = (adj.get(cur) ?? []).find((a) => a.other !== prev)
    if (!next) break
    // Cycle guard: a ring (A→B→C→A) has no leaf, so the "away from prev" walk
    // would loop until the 500 cap and duplicate nodes. Stop the moment we
    // revisit a node instead of relying on the cap.
    if (visited.has(next.other)) break
    visited.add(next.other)
    seq.push({ nodeId: next.other, edge: next.edge })
    prev = cur
    cur = next.other
    if (cur === stopAt) break
  }
  return seq
}

export function linearizeTrace(
  g: TraceGraph,
  selfCableId: string
): PathStep[] | null {
  const adj = wireAdj(g)
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]))
  const ends = [...adj.entries()].filter(([, a]) => a.length === 1)
  if (ends.length !== 2) return null // breakout fan-out or a loop
  if ([...adj.values()].some((a) => a.length > 2)) return null
  const seq = walkChain(ends[0][0], null, adj)
  return buildSteps(seq, nodeById, selfCableId)
}

export interface TraceTree {
  trunk: PathStep[]
  branches: PathStep[][]
}

/** One-to-many trace: a single fan-out node (a PON splitter's rear port, or a
 * breakout) makes the trace a star, not a line. Returns the shared trunk from
 * the origin to that node, plus one linear branch per other leg. `null` when
 * it isn't a single-level star (linear runs use linearizeTrace; deeper trees
 * fall back to the graph). */
export function treeizeTrace(
  g: TraceGraph,
  originNodeId: string,
  selfCableId: string
): TraceTree | null {
  const adj = wireAdj(g)
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]))
  const branchNodes = [...adj.entries()].filter(([, a]) => a.length > 2)
  if (branchNodes.length !== 1) return null
  const bId = branchNodes[0][0]
  if (!adj.has(originNodeId) || originNodeId === bId) return null

  // Trunk: origin leaf → branch node.
  const trunkSeq = walkChain(originNodeId, null, adj, bId)
  if (trunkSeq[trunkSeq.length - 1]?.nodeId !== bId) return null // origin not under B
  const cameFrom =
    trunkSeq.length >= 2 ? trunkSeq[trunkSeq.length - 2].nodeId : null
  const trunk = buildSteps(trunkSeq, nodeById, selfCableId)
  if (!trunk) return null

  // One branch per other neighbour of the fan-out node.
  const branches: PathStep[][] = []
  for (const nb of adj.get(bId) ?? []) {
    if (nb.other === cameFrom) continue
    const branchSeq: SeqItem[] = [
      { nodeId: bId },
      { nodeId: nb.other, edge: nb.edge },
      ...walkChain(nb.other, bId, adj).slice(1),
    ]
    const steps = buildSteps(branchSeq, nodeById, selfCableId)
    if (steps) branches.push(steps)
  }
  if (branches.length === 0) return null
  return { trunk, branches }
}

/**
 * The wire itself, drawn flat: `server:eth0 ─cat6─ panel front1 ⇄ rear ─trunk─
 * switch:gi1`. Replaces the static ⇄ icon on the cable page with the actual
 * end-to-end run (panels grouped into one chip with their strand ports).
 */
/** The flat end-to-end strip for any trace endpoint (interface / cable),
 * fetched from its trace URL. Falls back to `null` when the run can't be
 * drawn flat (breakout / loop / single node) — the graph map covers those. */
export function TracePathStrip({
  url,
  queryKey,
  highlightPort,
}: {
  url: string
  queryKey: unknown[]
  /** Emphasise this port's cell (the traced origin). */
  highlightPort?: string
}) {
  const q = useQuery({ queryKey, queryFn: () => api<TraceGraph>(url) })
  if (!q.data) return null
  const steps = linearizeTrace(q.data, "")
  if (!steps || steps.filter((s) => s.t === "chip").length < 2) return null
  return (
    <div className="max-w-4xl">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          End-to-end path
        </span>
        {!q.data.complete && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400">
            incomplete
          </span>
        )}
      </div>
      <PathStrip steps={steps} highlightPort={highlightPort} />
    </div>
  )
}

/** Overview-card trace preview: the flat strip when the run is linear, else a
 * compact fan-out summary (reached devices as links) for splitter/breakout
 * trees — which `linearizeTrace` can't draw flat. Renders nothing when there's
 * nothing traced. */
export function TracePreview({
  url,
  queryKey,
  highlightPort,
  originInterfaceId,
  originDeviceId,
}: {
  url: string
  queryKey: unknown[]
  highlightPort?: string
  /** The interface the trace started from — its node roots the fan-out tree. */
  originInterfaceId?: string
  /** The device the trace started from — excluded from the reached list. */
  originDeviceId?: string
}) {
  const q = useQuery({ queryKey, queryFn: () => api<TraceGraph>(url) })
  if (!q.data) return null

  const header = (
    <div className="mb-1.5 flex items-center gap-2">
      <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        End-to-end path
      </span>
      {!q.data.complete && (
        <span className="text-[10px] text-amber-600 dark:text-amber-400">
          incomplete
        </span>
      )}
    </div>
  )

  // 1) Linear run → the flat strip.
  const steps = linearizeTrace(q.data, "")
  if (steps && steps.filter((s) => s.t === "chip").length >= 2) {
    return (
      <div className="max-w-4xl">
        {header}
        <PathStrip steps={steps} highlightPort={highlightPort} />
      </div>
    )
  }

  // 2) One-to-many (splitter / breakout) → trunk + one branch strip per leg.
  const originNodeId = originInterfaceId ? `if:${originInterfaceId}` : ""
  const tree = originNodeId ? treeizeTrace(q.data, originNodeId, "") : null
  if (tree) {
    return (
      <div className="max-w-4xl">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Fans out to {tree.branches.length} leg
            {tree.branches.length === 1 ? "" : "s"}
          </span>
          {!q.data.complete && (
            <span className="text-[10px] text-amber-600 dark:text-amber-400">
              incomplete
            </span>
          )}
        </div>
        <PathStrip steps={tree.trunk} highlightPort={highlightPort} />
        <div className="mt-1.5 space-y-1 border-l border-border pl-3">
          {tree.branches.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="text-muted-foreground/60">└</span>
              <PathStrip steps={b} />
            </div>
          ))}
        </div>
      </div>
    )
  }

  // 3) Anything deeper → a compact reached-devices list.
  const devices = q.data.nodes.filter(
    (n) => n.type === "device" && n.data.device_id !== originDeviceId
  )
  if (devices.length === 0) return null
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Traces to {devices.length} device{devices.length === 1 ? "" : "s"}
        </span>
        {!q.data.complete && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400">
            incomplete
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {devices.map((n) =>
          n.data.device_id ? (
            <Link
              key={n.id}
              to="/devices/$id"
              params={{ id: n.data.device_id }}
              className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[12px] hover:bg-muted"
            >
              {n.data.name}
            </Link>
          ) : (
            <span
              key={n.id}
              className="rounded-md border border-border px-1.5 py-0.5 font-mono text-[12px]"
            >
              {n.data.name}
            </span>
          )
        )}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        Open the Trace tab for the full map.
      </p>
    </div>
  )
}

export function CableTracePath({
  cableId,
  fallback,
}: {
  cableId: string
  /** Rendered instead when the run can't be drawn flat — breakout fan-outs,
   * loops, uncabled ends, or while the trace is still loading. */
  fallback: React.ReactNode
}) {
  const q = useQuery({
    // Same key as the Trace tab, so opening it later is a cache hit.
    queryKey: ["trace", "cable", cableId],
    queryFn: () => api<TraceGraph>(`/api/cables/${cableId}/trace/`),
  })
  if (!q.data) return <>{fallback}</>
  const steps = linearizeTrace(q.data, cableId)
  if (!steps || steps.filter((s) => s.t === "chip").length < 2)
    return <>{fallback}</>

  return (
    <div className="max-w-4xl">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          End-to-end path
        </span>
        {!q.data.complete && (
          <span className="text-[10px] text-amber-600 dark:text-amber-400">
            incomplete
          </span>
        )}
      </div>
      <PathStrip steps={steps} />
    </div>
  )
}
