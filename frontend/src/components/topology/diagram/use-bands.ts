import { useMemo } from "react"
import type { RefObject } from "react"

import type { TopoNode } from "@/lib/api"
import type { CanvasBandEdit, CanvasHandle } from "../topology-canvas"
import type { PosMap, Zone } from "../view-positions"
import {
  BAND,
  arrangeBands,
  clearBands,
  handDrawn,
  isRow,
  isSide,
  newRow,
  newSide,
  normalizeRegions,
  reorderRow,
  reorderRows,
  resizeRow,
  ruleRow,
  rowsAt,
  sameGeometry,
  snapSide,
} from "./bands"
import type { ArrangeCard, BandBy, BandEdit, Region, RuleOf } from "./bands"
import type { RowsAt, RowSlot } from "./placement"
import type { Rect } from "./types"

/**
 * The Diagram's layer bands as page actions: each one reads the bands and
 * the cards as the canvas draws them, runs the pure edit (bands.ts), and
 * writes the bands and the arrangement it moved as ONE step - the page's
 * `setRegions` and `setPositions` are coalesced into a single undo step
 * when called from one handler.
 *
 * As drawn, not as saved: the build re-fits the rows round cards drawn at
 * another size (Detailed, photos; `fitRows`). An edit starts from what is
 * on screen, and when that differs from the saved rows it saves the rows
 * and every card where they are drawn with it - the saved rows and cards
 * never disagree on who is in which row.
 */
export interface BandsApi {
  /** The Diagram's zones and bands, normalised. */
  regions: Region[]
  /** Bands drawn by hand: rows (which Arrange replaces) and all of them
   * (which Clear removes). The page asks before dropping any. */
  handRows: number
  handBands: number
  hasBands: boolean
  /** Rows on the map (side bands aside). */
  hasRows: boolean
  arrange: (by: BandBy) => void
  clear: () => void
  addRow: () => void
  addSide: () => void
  /** Restack the rows in this top-to-bottom order (the sidebar). */
  reorder: (ids: string[]) => void
  /** The canvas's band edits that move cards: up/down, resize. */
  edit: (e: CanvasBandEdit) => void
  /** The canvas's `onZonesChange` on the Diagram: side bands moved or
   * resized by hand snap to the rows' edges. */
  onRegionsChange: (next: Zone[]) => void
  /** Where a dropped card goes when it lands in a row (placement.ts). */
  rowsAt: RowsAt
  /** The row made for a card's role or device type (placement.ts). */
  ruleRow: (card: RuleOf) => RowSlot | null
  /** The rows Arrange made rule the stack: Re-layout arranges them again
   * by what they were made from (null: none, or only rows drawn by hand). */
  ruleBy: BandBy | null
  /** Save the bands and the cards as drawn, when the build re-fitted the
   * rows: before an edit that saves card positions. True when it did. */
  keepDrawn: () => boolean
}

export function useBands(opts: {
  regions: readonly Zone[] | undefined
  setRegions: (next: Zone[]) => void
  /** The arrangement: the canvas's full snapshot, as a drag writes it. */
  setPositions: (positions: PosMap) => void
  canvas: RefObject<CanvasHandle | null>
  /** The graph's nodes, for each card's role and device type. */
  nodes: readonly TopoNode[] | undefined
  /** The Levels organiser's role order and bonds. */
  levels: { order: string[]; bonds: string[] }
  /** The layout's direction: a side-to-side one ranks along x. */
  direction: "LR" | "TB"
}): BandsApi {
  const { setRegions, setPositions, canvas, nodes, levels, direction } = opts
  const regions = useMemo(() => normalizeRegions(opts.regions), [opts.regions])
  /** On the Diagram: the canvas draws these bands. */
  const on = opts.regions !== undefined

  return useMemo<BandsApi>(() => {
    const boxes = () => canvas.current?.boxes() ?? {}
    /** The zones and bands as the canvas draws them. */
    const live = () => {
      const drawn = on ? canvas.current?.regions() : undefined
      return drawn ? normalizeRegions(drawn) : regions
    }
    /** The rows as drawn are not the ones saved. */
    const refitted = () => !sameGeometry(live(), regions)
    /** Bands and the cards they moved, as one step - every card where it
     * is drawn when the rows were re-fitted. */
    const apply = (e: BandEdit) => {
      const fitted = refitted()
      setRegions(e.regions)
      if (fitted || Object.keys(e.moves).length)
        setPositions({ ...(canvas.current?.positions() ?? {}), ...e.moves })
    }
    const keepDrawn = () => {
      if (!refitted()) return false
      setRegions(live())
      setPositions(canvas.current?.positions() ?? {})
      return true
    }
    const byRule = [
      ...new Set(regions.filter(isRow).flatMap((r) => r.rule?.by ?? [])),
    ]
    const focus = (rects: readonly Rect[]) => {
      if (!rects.length) return
      const x = Math.min(...rects.map((r) => r.x))
      const y = Math.min(...rects.map((r) => r.y))
      canvas.current?.focusZone({
        x,
        y,
        w: Math.max(...rects.map((r) => r.x + r.w)) - x,
        h: Math.max(...rects.map((r) => r.y + r.h)) - y,
      })
    }
    const at = () => canvas.current?.center() ?? { x: 0, y: 0 }
    const id = () => `b${Date.now().toString(36)}`
    const hand = handDrawn(regions)
    return {
      regions,
      handRows: hand.filter(isRow).length,
      handBands: hand.length,
      hasBands: regions.some((r) => r.kind === "band"),
      hasRows: regions.some(isRow),
      ruleBy: byRule.length === 1 ? byRule[0] : null,
      keepDrawn,
      arrange: (by) => {
        const box = boxes()
        const cards: ArrangeCard[] = []
        for (const n of nodes ?? []) {
          const b = box[n.id] as Rect | undefined
          if (!b || !n.data.device_id) continue
          const d = n.data
          cards.push({
            id: n.id,
            box: b,
            role: d.role ? { id: d.role.id, name: d.role.name } : null,
            type:
              d.device_type_id || d.device_type
                ? { id: d.device_type_id, name: d.device_type }
                : null,
          })
        }
        if (!cards.length) return
        const res = arrangeBands({
          cards,
          by,
          levels,
          regions: live(),
          axis: direction === "LR" ? "x" : "y",
        })
        setRegions(res.regions)
        setPositions({
          ...(canvas.current?.positions() ?? {}),
          ...res.positions,
        })
        focus(res.regions.filter((r) => r.kind === "band"))
      },
      clear: () => setRegions(clearBands(regions)),
      addRow: () => {
        const now = live()
        const band = newRow(now, id(), Object.values(boxes()), at())
        apply({ regions: [...now, band], moves: {} })
        focus([band])
      },
      addSide: () => {
        const now = live()
        const band = newSide(now, id(), at())
        apply({ regions: [...now, band], moves: {} })
        focus([band])
      },
      reorder: (ids) => apply(reorderRows(live(), boxes(), ids)),
      edit: (e) => {
        const now = live()
        if (e.type === "move") {
          apply(reorderRow(now, boxes(), e.id, e.dir))
          return
        }
        const band = now.find((r) => r.id === e.id)
        if (band && isSide(band)) {
          // A side band carries nothing: resized, it snaps to the rows.
          const r = e.rect
          const next = now.map((x) =>
            x.id === e.id
              ? {
                  ...x,
                  x: Math.round(r.x),
                  y: Math.round(r.y),
                  w: Math.round(Math.max(BAND.MIN_W, r.w)),
                  h: Math.round(Math.max(BAND.MIN_H, r.h)),
                }
              : x
          )
          apply({ regions: snapSide(next, e.id), moves: {} })
          return
        }
        apply(resizeRow(now, boxes(), e.id, e.rect))
      },
      onRegionsChange: (next) => {
        const was = new Map(regions.map((r) => [r.id, r]))
        let out = normalizeRegions(next)
        for (const r of out) {
          const p = was.get(r.id)
          const moved =
            !p || p.x !== r.x || p.y !== r.y || p.w !== r.w || p.h !== r.h
          if (isSide(r) && moved) out = snapSide(out, r.id)
        }
        setRegions(out)
      },
      rowsAt: (p) => rowsAt(live())(p),
      ruleRow: (card) => ruleRow(live())(card),
    }
  }, [regions, on, nodes, levels, direction, canvas, setRegions, setPositions])
}
