import { useMemo } from "react"

// The OpenStack-style rail diagram, generalised: full-width coloured rails
// grouped into titled sections, boxes drawn ONCE in the band under their
// topmost rail with a coloured leg to every rail they attach to. Extracted
// from the Virtual network topology page so the topology page's Logical
// (VLAN) view and the virtual view share one layout - the column allocation,
// ribbon legs, and luminance-picked rail text move here verbatim.

export interface RailInput {
  id: string
  label: string
  /** "" → a deterministic palette shade by rail index. */
  color: string
  onClick?: () => void
}

export interface AdapterInput {
  key: string
  nic: string
  host: string
  onClick?: () => void
}

export interface SectionInput {
  id: string
  title: string
  subtitle?: string
  onTitleClick?: () => void
  /** Physical adapters pinned to the section strip's right edge. */
  adapters?: AdapterInput[]
  rails: RailInput[]
}

export interface LegInput {
  railId: string
  label?: string
  /** Dashed leg (logical view: a tagged/trunk attachment). */
  dashed?: boolean
  /** Makes the leg's label clickable (logical view: open the interface). */
  onClick?: () => void
}

export interface BoxInput {
  id: string
  name: string
  /** Corner status pill; colour by up/down-ish regex. */
  status?: string | null
  /** Dashed box border (logical view: virtual machines). */
  dashed?: boolean
  onClick?: () => void
  legs: LegInput[]
}

// ─── layout geometry ─────────────────────────────────────────────────────────
const PAD = 32
const EXT_H = 30
const STRIP_H = 42
const STRIP_GAP = 16
const RAIL_H = 30
const RAIL_GAP = 22 // gap under a rail with no boxes (room for leg labels)
const BOX_W = 140
const BOX_H = 60
const BOX_GAP = 18
const COL_PITCH = BOX_W + BOX_GAP
const BAND_PAD = 18 // space above/below a box row (room for leg labels)
const BAND_H = BOX_H + 2 * BAND_PAD
const LABEL_RESERVE = 216 // rail label zone - box columns start after it
const ADP_W = 116
const ADP_H = 34
const ADP_GAP = 8

// Deterministic rail palette - shades of the Danbyte blue, used when a rail
// carries no colour of its own (a VLAN colour or zone colour overrides it).
const PALETTE = [
  "#1d63ed",
  "#0ea5e9",
  "#1e40af",
  "#38bdf8",
  "#2563eb",
  "#0369a1",
  "#60a5fa",
  "#075985",
]

/** Colour for the little status pill on a box's corner. */
function statusPill(status: string | null | undefined): {
  bg: string
  fg: string
} {
  const s = (status || "").toLowerCase()
  if (/(active|running|up|online|powered.?on)/.test(s))
    return { bg: "#10b981", fg: "#fff" }
  if (/(off|down|decom|failed|stopped|suspend)/.test(s))
    return { bg: "#ef4444", fg: "#fff" }
  return { bg: "var(--muted)", fg: "var(--muted-foreground)" }
}

/** Truncate to fit a node width (SVG text doesn't wrap). */
function fit(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s
}

/** Black or white label for a solid rail, by perceived luminance (Rec. 709). */
export function railText(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!m) return "#fff"
  const n = parseInt(m[1], 16)
  const l =
    0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)
  return l > 150 ? "#111" : "#fff"
}

interface LaidRail {
  id: string
  y: number
  color: string
  label: string
  onClick?: () => void
}
interface LaidStrip {
  id: string
  y: number
  name: string
  kind: string
  onClick?: () => void
  adapters: {
    key: string
    x: number
    nic: string
    host: string
    onClick?: () => void
  }[]
}
interface LaidBox {
  id: string
  x: number
  y: number
  name: string
  status: string | null
  dashed: boolean
  onClick?: () => void
}
interface Laid {
  width: number
  height: number
  strips: LaidStrip[]
  rails: LaidRail[]
  boxes: LaidBox[]
  lines: {
    key: string
    x: number
    y1: number
    y2: number
    color: string
    dashed?: boolean
    label?: string
    labelX?: number
    labelY?: number
    onClick?: () => void
  }[]
}

function layout(sections: SectionInput[], boxesIn: BoxInput[]): Laid {
  // 1. Flatten rails in section order.
  const rails: { rail: RailInput; section: number }[] = []
  const secSpans = sections.map((sec, si) => {
    const start = rails.length
    for (const r of sec.rails) rails.push({ rail: r, section: si })
    return { start, end: rails.length - 1 }
  })
  const railIdx = new Map<string, number>()
  rails.forEach((r, i) => railIdx.set(r.rail.id, i))

  // 2. Each box → the rail indexes it attaches to (legs to unknown rails drop).
  const attached = boxesIn
    .map((b) => {
      const legs = b.legs
        .filter((l) => railIdx.has(l.railId))
        .map((l) => ({ ...l, idx: railIdx.get(l.railId)! }))
        .sort((a, b2) => a.idx - b2.idx)
      return { box: b, legs }
    })
    .filter((b) => b.legs.length > 0)
    .sort((a, b2) => {
      const ra = a.legs[0].idx
      const rb = b2.legs[0].idx
      return ra !== rb ? ra - rb : a.box.name.localeCompare(b2.box.name)
    })

  // 3. Column allocation - a box occupies its column in every band its
  //    connector passes through, so nothing ever overlaps.
  const bandCols: Set<number>[] = rails.map(() => new Set())
  const placed: {
    box: BoxInput
    legs: {
      railId: string
      label?: string
      dashed?: boolean
      onClick?: () => void
      idx: number
    }[]
    col: number
    band: number
  }[] = []
  for (const b of attached) {
    const first = b.legs[0].idx
    const last = b.legs[b.legs.length - 1].idx
    const span: number[] = []
    for (let i = first; i <= last; i++) span.push(i)
    let col = 0
    while (span.some((i) => bandCols[i].has(col))) col++
    span.forEach((i) => bandCols[i].add(col))
    placed.push({ box: b.box, legs: b.legs, col, band: first })
  }
  const maxCols = placed.reduce((m, p) => Math.max(m, p.col + 1), 0)
  const width = Math.max(
    PAD * 2 + LABEL_RESERVE + maxCols * COL_PITCH + COL_PITCH / 2,
    900
  )

  // 4. Vertical pass: per section: strip → rails with bands.
  const strips: LaidStrip[] = []
  const laidRails: LaidRail[] = []
  const railY: number[] = []
  const bandY: number[] = []
  let y = PAD / 2 + EXT_H + STRIP_GAP
  sections.forEach((sec, si) => {
    const ups = sec.adapters ?? []
    strips.push({
      id: sec.id,
      y,
      name: sec.title,
      kind: sec.subtitle ?? "",
      onClick: sec.onTitleClick,
      adapters: ups.map((u, i) => ({
        key: u.key,
        x: width - PAD - (ups.length - i) * (ADP_W + ADP_GAP) + ADP_GAP,
        nic: u.nic,
        host: u.host,
        onClick: u.onClick,
      })),
    })
    y += STRIP_H + STRIP_GAP
    const span = secSpans[si]
    for (let i = span.start; i <= span.end; i++) {
      const { rail } = rails[i]
      laidRails.push({
        id: rail.id,
        y,
        color: rail.color || PALETTE[i % PALETTE.length],
        label: rail.label,
        onClick: rail.onClick,
      })
      railY[i] = y
      y += RAIL_H
      bandY[i] = y
      y += bandCols[i].size > 0 ? BAND_H : RAIL_GAP
    }
    y += STRIP_GAP / 2
  })

  // 5. Boxes + solid connectors, one coloured segment per attached rail
  //    (the stub carries the rail's colour; ribbon-cable fan for multi-leg).
  const boxes: LaidBox[] = []
  const lines: Laid["lines"] = []
  for (const p of placed) {
    const stagger = (p.band % 2) * (COL_PITCH / 2)
    const x = PAD + LABEL_RESERVE + stagger + p.col * COL_PITCH + BOX_W / 2
    const boxY = bandY[p.band] + BAND_PAD
    boxes.push({
      id: p.box.id,
      x,
      y: boxY,
      name: p.box.name,
      status: p.box.status ?? null,
      dashed: !!p.box.dashed,
      onClick: p.box.onClick,
    })
    const firstRail = p.legs[0].idx
    const n = p.legs.length
    p.legs.forEach((leg, k) => {
      const lx = x + (k - (n - 1) / 2) * 6
      const labelX = x + ((n - 1) / 2) * 6 + 8 // clear of the whole ribbon
      const color = laidRails[leg.idx].color
      if (leg.idx === firstRail) {
        lines.push({
          key: `u-${p.box.id}-${k}`,
          x: lx,
          y1: railY[leg.idx] + RAIL_H / 2, // under the bar - rails draw on top
          y2: boxY,
          color,
          dashed: leg.dashed,
          label: leg.label,
          labelX,
          labelY: boxY - 4,
          onClick: leg.onClick,
        })
      } else {
        lines.push({
          key: `d-${p.box.id}-${leg.idx}-${k}`,
          x: lx,
          y1: boxY + BOX_H,
          y2: railY[leg.idx] + RAIL_H / 2,
          color,
          dashed: leg.dashed,
          label: leg.label,
          labelX,
          labelY: railY[leg.idx] - 4,
          onClick: leg.onClick,
        })
      }
    })
  }

  const height = y + PAD / 2
  return { width, height, strips, rails: laidRails, boxes, lines }
}

export function RailDiagram({
  sections,
  boxes,
  externalLabel,
}: {
  sections: SectionInput[]
  boxes: BoxInput[]
  /** Render the full-width bar above everything (e.g. "External network"). */
  externalLabel?: string
}) {
  const laid = useMemo(() => layout(sections, boxes), [sections, boxes])
  return (
    <svg
      width={laid.width}
      height={laid.height}
      className="min-w-full"
      style={{ fontFamily: "inherit" }}
    >
      {externalLabel && (
        <>
          <rect
            x={PAD}
            y={PAD / 2}
            width={laid.width - 2 * PAD}
            height={EXT_H}
            rx={6}
            fill="var(--muted)"
            stroke="var(--border)"
          />
          <text
            x={PAD + 12}
            y={PAD / 2 + EXT_H / 2 + 4}
            fontSize={12}
            fontWeight={600}
            fill="var(--muted-foreground)"
          >
            {externalLabel}
          </text>
        </>
      )}

      {/* connectors (behind boxes) - solid/dashed, in the rail's colour */}
      {laid.lines.map((l) => (
        <line
          key={l.key}
          x1={l.x}
          y1={l.y1}
          x2={l.x}
          y2={l.y2}
          stroke={l.color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={l.dashed ? "5 5" : undefined}
        />
      ))}
      {/* labels after the lanes, clear of the ribbon bundle */}
      {laid.lines.map((l) =>
        l.label ? (
          <text
            key={`lbl-${l.key}`}
            x={l.labelX ?? l.x + 7}
            y={l.labelY ?? Math.max(l.y1, l.y2) - 5}
            fontSize={9}
            className={l.onClick ? "cursor-pointer font-mono hover:underline" : "font-mono"}
            fill="var(--muted-foreground)"
            onClick={l.onClick}
          >
            {l.label}
          </text>
        ) : null
      )}

      {/* section strips + their physical adapters */}
      {laid.strips.map((s) => (
        <g key={s.id}>
          <g
            className={s.onClick ? "cursor-pointer" : undefined}
            onClick={s.onClick}
          >
            <text
              x={PAD}
              y={s.y + 18}
              fontSize={13}
              fontWeight={600}
              fill="var(--foreground)"
            >
              {fit(s.name, 40)}
            </text>
            <text
              x={PAD}
              y={s.y + 34}
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              {s.kind}
            </text>
          </g>
          {s.adapters.map((a) => (
            <g
              key={a.key}
              className={a.onClick ? "cursor-pointer" : undefined}
              onClick={a.onClick}
            >
              <rect
                x={a.x}
                y={s.y + (STRIP_H - ADP_H) / 2}
                width={ADP_W}
                height={ADP_H}
                rx={6}
                fill="var(--muted)"
                stroke="var(--border)"
              />
              <text
                x={a.x + ADP_W / 2}
                y={s.y + STRIP_H / 2 - 2}
                fontSize={10}
                fontWeight={600}
                textAnchor="middle"
                fill="var(--foreground)"
                className="font-mono"
              >
                {fit(a.nic, 14)}
              </text>
              <text
                x={a.x + ADP_W / 2}
                y={s.y + STRIP_H / 2 + 11}
                fontSize={9}
                textAnchor="middle"
                fill="var(--muted-foreground)"
              >
                {fit(a.host, 16)}
              </text>
            </g>
          ))}
        </g>
      ))}

      {/* rails - full-width coloured bars */}
      {laid.rails.map((r) => (
        <g
          key={r.id}
          className={r.onClick ? "cursor-pointer" : undefined}
          onClick={r.onClick}
        >
          <rect
            x={PAD}
            y={r.y}
            width={laid.width - 2 * PAD}
            height={RAIL_H}
            rx={6}
            fill={r.color}
            fillOpacity={1}
          />
          <text
            x={PAD + 12}
            y={r.y + RAIL_H / 2 + 4}
            fontSize={12}
            fontWeight={600}
            fill={railText(r.color)}
          >
            {fit(r.label, 34)}
          </text>
        </g>
      ))}

      {/* boxes - one per object, neutral card with a corner status pill */}
      {laid.boxes.map((b) => {
        const pill = statusPill(b.status)
        const label = fit(b.status || "", 14)
        const pw = label ? label.length * 5.4 + 12 : 0
        return (
          <g
            key={b.id}
            className={b.onClick ? "cursor-pointer" : undefined}
            onClick={b.onClick}
          >
            <rect
              x={b.x - BOX_W / 2}
              y={b.y}
              width={BOX_W}
              height={BOX_H}
              rx={8}
              fill="var(--card)"
              stroke="var(--border)"
              strokeDasharray={b.dashed ? "5 4" : undefined}
            />
            <text
              x={b.x}
              y={b.y + BOX_H / 2 + 4}
              fontSize={12}
              fontWeight={600}
              textAnchor="middle"
              fill="var(--foreground)"
            >
              {fit(b.name, 16)}
            </text>
            {label && (
              <g>
                <rect
                  x={b.x + BOX_W / 2 - pw - 5}
                  y={b.y + 5}
                  width={pw}
                  height={14}
                  rx={4}
                  fill={pill.bg}
                />
                <text
                  x={b.x + BOX_W / 2 - pw / 2 - 5}
                  y={b.y + 15}
                  fontSize={9}
                  fontWeight={600}
                  textAnchor="middle"
                  fill={pill.fg}
                >
                  {label}
                </text>
              </g>
            )}
          </g>
        )
      })}
    </svg>
  )
}
