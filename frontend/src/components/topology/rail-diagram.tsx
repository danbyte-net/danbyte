import {
  forwardRef,
  Fragment,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react"
import type { CSSProperties, ReactNode, RefObject } from "react"
import { Link } from "@tanstack/react-router"

import { StatusBadge } from "@/components/status-badge"
import { CanvasTip, TIP_ATTR } from "@/components/topology/canvas-tip"
import type { CanvasTipHandle } from "@/components/topology/canvas-tip"
import { layoutRails, RAIL } from "@/lib/diagram/rails"
import type {
  LaidBox,
  LaidLegLabel,
  LaidPill,
  LaidRail,
  LaidStrip,
  RailLayout,
  RailModel,
  RailTarget,
  RailText,
} from "@/lib/diagram/rails"
import { CARD, LABEL, mix } from "@/lib/diagram/theme"
import type { Rect } from "@/lib/diagram/types"
import { cn } from "@/lib/utils"

// The rail diagram on screen: the Logical tab, the Virtual topology page and
// a VM's Topology card draw the one layout from lib/diagram/rails.ts, which
// the exports draw too. Rails, cards, section titles and host NICs are HTML
// at the layout's positions over an SVG of the legs, so every item that
// opens something is a router link you can tab to, and the status pills are
// the shared StatusBadge.
//
// A name cut short to fit names itself on hover through the canvas tip
// (the topology canvas's one tooltip), and under the item when it has
// keyboard focus.

const FOCUS =
  "outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"

/** The pill at card scale, as the Diagram card draws it. */
const STATUS_PILL =
  "block h-4 max-w-24 shrink-0 truncate px-1.5 py-0 text-[9px] leading-[14px]"

/** The tip for a string cut short, else none. */
const cutTip = (t: RailText) => (t.text !== t.full ? t.full : undefined)

type ItemProps = {
  target?: RailTarget
  className?: string
  style?: CSSProperties
  /** The whole name, when what is drawn is cut short. */
  tip?: string
  /** The accessible name, when the text inside is not it. */
  label?: string
  children: ReactNode
}

/** An item that opens its target: a router link, or a plain box. */
function Item({ target, className, style, tip, label, children }: ItemProps) {
  const common = {
    className: cn(className, target && FOCUS),
    style,
    "aria-label": label,
    [TIP_ATTR]: tip,
  }
  if (!target) return <div {...common}>{children}</div>
  const params = { id: target.id }
  switch (target.kind) {
    case "vlan":
      return (
        <Link to="/vlans/$id" params={params} {...common}>
          {children}
        </Link>
      )
    case "device":
      return (
        <Link to="/devices/$id" params={params} {...common}>
          {children}
        </Link>
      )
    case "vm":
      return (
        <Link to="/virtual-machines/$id" params={params} {...common}>
          {children}
        </Link>
      )
    case "interface":
      return (
        <Link to="/interfaces/$id" params={params} {...common}>
          {children}
        </Link>
      )
    case "vswitch":
      return (
        <Link to="/virtual-switches/$id" params={params} {...common}>
          {children}
        </Link>
      )
  }
}

/** A status pill at `p`, placed in its parent's frame. On a colored card
 * or rail it keeps a white edge, as in the exports, so a pill of a similar
 * color still stands apart. */
function Pill({
  p,
  frame,
  onFill,
}: {
  p: LaidPill
  frame: Rect
  onFill: boolean
}) {
  return (
    <span
      className="absolute flex"
      style={{ left: p.x - frame.x, top: p.y - frame.y }}
    >
      <StatusBadge
        status={p.status}
        className={cn(STATUS_PILL, onFill && "outline-1 outline-white/80")}
      />
    </span>
  )
}

function RailBar({ r }: { r: LaidRail }) {
  return (
    <Item
      target={r.target}
      tip={cutTip(r.label)}
      label={[r.label.full, r.pill?.status.name, r.detail?.full]
        .filter(Boolean)
        .join(", ")}
      className="absolute rounded-md border"
      style={{
        left: r.x,
        top: r.y,
        width: r.w,
        height: r.h,
        backgroundColor: r.fill,
        borderColor: r.edge,
        color: r.ink,
      }}
    >
      <span
        className="absolute font-bold whitespace-nowrap"
        style={{
          // Inside the 1px border.
          left: r.labelX - r.x - 1,
          top: 0,
          lineHeight: `${r.h - 2}px`,
          fontSize: CARD.TITLE_SIZE,
        }}
      >
        {r.label.text}
      </span>
      {r.pill && (
        <Pill p={r.pill} frame={{ ...r, x: r.x + 1, y: r.y + 1 }} onFill />
      )}
      {r.detail && (
        <span
          className="absolute whitespace-nowrap"
          style={{
            right: r.x + r.w - r.detail.right - 1,
            top: 0,
            lineHeight: `${r.h - 2}px`,
            fontSize: RAIL.DETAIL_SIZE,
            opacity: CARD.LINE_INK,
          }}
          {...{ [TIP_ATTR]: cutTip(r.detail) }}
        >
          {r.detail.text}
        </span>
      )}
    </Item>
  )
}

function Card({ b }: { b: LaidBox }) {
  const edge = b.fill
    ? mix("#000000", b.fill, b.vm ? 0.35 : CARD.EDGE_DARKEN)
    : undefined
  return (
    <Item
      target={b.target}
      tip={cutTip(b.name)}
      label={[b.name.full, b.pill?.status.name].filter(Boolean).join(", ")}
      className={cn(
        "absolute rounded-lg",
        !b.fill && "bg-muted text-foreground"
      )}
      style={{
        left: b.x,
        top: b.y,
        width: b.w,
        height: b.h,
        ...(b.fill
          ? { backgroundColor: b.fill, color: b.ink ?? undefined }
          : {}),
      }}
    >
      {/* The 1px edge, the Diagram card's: the fill a step darker, or the
          border on a neutral card. A VM's is dashed. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 rounded-lg border",
          !b.fill && (b.vm ? "border-muted-foreground/60" : "border-border"),
          b.vm && "border-dashed"
        )}
        style={edge ? { borderColor: edge } : undefined}
      />
      {b.pill && <Pill p={b.pill} frame={b} onFill={!!b.fill} />}
      <div
        className="absolute inset-x-0 truncate text-center font-bold"
        style={{
          top: b.titleTop - b.y,
          height: CARD.TITLE_LH,
          lineHeight: `${CARD.TITLE_LH}px`,
          fontSize: CARD.TITLE_SIZE,
          paddingInline: CARD.PAD_X,
        }}
      >
        {b.name.text}
      </div>
      {b.lines.map((l, i) => (
        <div
          key={i}
          className="absolute inset-x-0 truncate text-center"
          style={{
            top: l.top - b.y,
            height: CARD.LINE_LH,
            lineHeight: `${CARD.LINE_LH}px`,
            fontSize: CARD.LINE_SIZE,
            paddingInline: CARD.PAD_X,
            opacity: CARD.LINE_INK,
          }}
        >
          {l.text}
        </div>
      ))}
    </Item>
  )
}

const LINK_TEXT = "rounded-sm hover:text-foreground hover:underline"

/** One card's interface names for one rail, beside its legs. */
function LegLabel({ l }: { l: LaidLegLabel }) {
  return (
    <div
      className="absolute whitespace-nowrap text-muted-foreground"
      style={{
        left: l.x,
        top: l.y,
        height: l.h,
        lineHeight: `${l.h}px`,
        fontSize: LABEL.END_SIZE,
      }}
      {...{ [TIP_ATTR]: l.text !== l.full ? l.full : undefined }}
    >
      {l.clipped ? (
        l.target ? (
          <Item target={l.target} className={LINK_TEXT} label={l.full}>
            {l.text}
          </Item>
        ) : (
          l.text
        )
      ) : (
        l.parts.map((p, i) => (
          <Fragment key={i}>
            {i > 0 && ", "}
            {p.target ? (
              <Item target={p.target} className={cn("inline", LINK_TEXT)}>
                {p.text}
              </Item>
            ) : (
              p.text
            )}
          </Fragment>
        ))
      )}
      {l.more > 0 && ` +${l.more}`}
    </div>
  )
}

/** A section's title row: its name over what it is, and its host NICs at
 * the right end. */
function Strip({ s }: { s: LaidStrip }) {
  return (
    <>
      {s.title.text && (
        <Item
          target={s.target}
          tip={cutTip(s.title)}
          label={s.title.full}
          className="absolute rounded-sm font-semibold whitespace-nowrap text-foreground hover:underline"
          style={{
            left: s.x,
            top: s.y,
            fontSize: RAIL.TITLE_SIZE,
            lineHeight: `${RAIL.TITLE_LH}px`,
          }}
        >
          {s.title.text}
        </Item>
      )}
      {s.subtitle.text && (
        <div
          className="absolute whitespace-nowrap text-muted-foreground"
          style={{
            left: s.x,
            top: s.y + RAIL.TITLE_LH + 2,
            fontSize: RAIL.SUB_SIZE,
            lineHeight: `${RAIL.SUB_LH}px`,
          }}
          {...{ [TIP_ATTR]: cutTip(s.subtitle) }}
        >
          {s.subtitle.text}
        </div>
      )}
      {s.adapters.map((a) => (
        <Item
          key={a.key}
          target={a.target}
          tip={
            cutTip(a.nic) || cutTip(a.host)
              ? `${a.nic.full} · ${a.host.full}`
              : undefined
          }
          label={`${a.nic.full}, ${a.host.full}`}
          className="absolute rounded-lg border border-border bg-muted text-center text-foreground"
          style={{ left: a.x, top: a.y, width: a.w, height: a.h }}
        >
          <div
            className="truncate font-bold"
            style={{
              marginTop: CARD.PAD_Y - 1,
              lineHeight: `${CARD.TITLE_LH}px`,
              fontSize: CARD.TITLE_SIZE,
              paddingInline: CARD.PAD_X - 1,
            }}
          >
            {a.nic.text}
          </div>
          <div
            className="truncate"
            style={{
              marginTop: CARD.LINES_GAP,
              lineHeight: `${CARD.LINE_LH}px`,
              fontSize: CARD.LINE_SIZE,
              paddingInline: CARD.PAD_X - 1,
              opacity: CARD.LINE_INK,
            }}
          >
            {a.host.text}
          </div>
        </Item>
      ))}
    </>
  )
}

/**
 * A laid-out rail diagram at its own size. Items come in reading order -
 * each rail after its section's title, then the cards hanging under it with
 * their leg labels - so Tab walks the diagram top to bottom.
 */
export function RailDiagram({
  layout,
  label,
}: {
  layout: RailLayout
  /** What the diagram is, for assistive tech ("Logical topology"). */
  label: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const tip = useRef<CanvasTipHandle>(null)

  // Focus on an item whose name is cut short shows the whole name under it,
  // as a hover does - so the keyboard gets the tip too.
  useEffect(() => {
    const el = root.current
    if (!el) return
    const focus = (ev: FocusEvent) => {
      const t =
        ev.target instanceof Element ? ev.target.closest(`[${TIP_ATTR}]`) : null
      if (!t || !el.contains(t)) return
      const r = t.getBoundingClientRect()
      tip.current?.show(t.getAttribute(TIP_ATTR), {
        clientX: r.left,
        clientY: r.bottom,
      })
    }
    const blur = () => tip.current?.hide()
    el.addEventListener("focusin", focus)
    el.addEventListener("focusout", blur)
    return () => {
      el.removeEventListener("focusin", focus)
      el.removeEventListener("focusout", blur)
    }
  }, [])

  const { byBand, labelsOf, stripAt } = useMemo(() => {
    const bands = new Map<number, LaidBox[]>()
    for (const b of [...layout.boxes].sort((a, c) => a.x - c.x)) {
      const l = bands.get(b.band)
      if (l) l.push(b)
      else bands.set(b.band, [b])
    }
    const labels = new Map<string, LaidLegLabel[]>()
    for (const l of layout.labels) {
      const list = labels.get(l.box)
      if (list) list.push(l)
      else labels.set(l.box, [l])
    }
    return {
      byBand: bands,
      labelsOf: labels,
      stripAt: new Map(layout.strips.map((s) => [s.firstRail, s])),
    }
  }, [layout])

  const ext = layout.external
  return (
    <div
      ref={root}
      role="group"
      aria-label={label}
      className="relative text-foreground"
      style={{ width: layout.width, height: layout.height }}
    >
      {/* The legs, under everything: the rails and cards cover their ends. */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0"
        width={layout.width}
        height={layout.height}
      >
        {layout.legs.map((l) => (
          <line
            key={l.key}
            x1={l.x}
            y1={l.y1}
            x2={l.x}
            y2={l.y2}
            stroke={l.color}
            strokeWidth={RAIL.LEG_W}
            strokeDasharray={l.dashed ? RAIL.DASH : undefined}
            strokeLinecap={l.dashed ? "butt" : "round"}
          />
        ))}
      </svg>
      {ext && (
        <div
          className="absolute rounded-md border border-border bg-muted font-bold whitespace-nowrap text-muted-foreground"
          style={{
            left: ext.x,
            top: ext.y,
            width: ext.w,
            height: ext.h,
            paddingLeft: RAIL.INSET - 1,
            lineHeight: `${ext.h - 2}px`,
            fontSize: CARD.TITLE_SIZE,
          }}
          {...{ [TIP_ATTR]: cutTip(ext.label) }}
        >
          {ext.label.text}
        </div>
      )}
      {stripAt.get(-1) && <Strip s={stripAt.get(-1)!} />}
      {layout.rails.map((r, i) => (
        <Fragment key={r.id}>
          {stripAt.get(i) && <Strip s={stripAt.get(i)!} />}
          <RailBar r={r} />
          {(byBand.get(i) ?? []).map((b) => (
            <Fragment key={b.id}>
              <Card b={b} />
              {(labelsOf.get(b.id) ?? []).map((l) => (
                <LegLabel key={l.key} l={l} />
              ))}
            </Fragment>
          ))}
        </Fragment>
      ))}
      <CanvasTip ref={tip} root={root} />
    </div>
  )
}

/** An element's content width, kept current. */
function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setWidth(el.clientWidth)
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}

/** An element's height, kept current. */
function useHeight(ref: RefObject<HTMLElement | null>): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    setHeight(el.offsetHeight)
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => setHeight(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return height
}

export interface RailCanvasHandle {
  /** The part of the diagram in view, in diagram pixels. */
  visible: () => Rect | null
  /** The width the diagram fills on screen. */
  width: () => number
}

/**
 * A rail diagram filling its (positioned) parent: the rails span the width,
 * the drawing scrolls both ways, and `legend` sits in the bottom-left corner
 * as on the topology canvas - with room kept under the drawing so nothing
 * stays hidden behind it.
 */
export const RailCanvas = forwardRef<
  RailCanvasHandle,
  { model: RailModel; label: string; legend?: ReactNode }
>(function RailCanvas({ model, label, legend }, ref) {
  const scroller = useRef<HTMLDivElement>(null)
  const legendBox = useRef<HTMLDivElement>(null)
  const width = useWidth(scroller)
  const legendH = useHeight(legendBox)
  const layout = useMemo(() => layoutRails(model, { width }), [model, width])
  useImperativeHandle(
    ref,
    () => ({
      visible: () => {
        const el = scroller.current
        return el
          ? {
              x: el.scrollLeft,
              y: el.scrollTop,
              w: el.clientWidth,
              h: el.clientHeight,
            }
          : null
      },
      width: () => width,
    }),
    [width]
  )
  return (
    <div className="absolute inset-0">
      <div ref={scroller} className="absolute inset-0 overflow-auto">
        <RailDiagram layout={layout} label={label} />
        {legend && legendH > 0 && (
          <div aria-hidden style={{ height: legendH }} />
        )}
      </div>
      {legend && (
        <div ref={legendBox} className="absolute bottom-4 left-4 z-10">
          {legend}
        </div>
      )}
    </div>
  )
})

/** A rail diagram as tall as it draws, in a bordered frame that scrolls
 * sideways - for a card on a detail page. */
export function RailFrame({
  model,
  label,
}: {
  model: RailModel
  label: string
}) {
  const frame = useRef<HTMLDivElement>(null)
  const width = useWidth(frame)
  const layout = useMemo(() => layoutRails(model, { width }), [model, width])
  return (
    <div
      ref={frame}
      className="overflow-x-auto rounded-lg border border-border bg-muted/10"
    >
      <RailDiagram layout={layout} label={label} />
    </div>
  )
}
