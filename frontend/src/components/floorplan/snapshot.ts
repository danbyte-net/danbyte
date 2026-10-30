import type { FloorPlan, FloorPlanContents } from "@/lib/api"

// Snapshots (docs: floor-plans "Snapshots"): a live view shows a rectangle
// of its source plan and edits the source's objects there; an independent
// copy is an ordinary plan. These helpers are what the editor needs to tell
// them apart and draw a view.

/** A live view of another plan's rectangle. */
export function isLiveView(plan: Pick<FloorPlan, "kind"> | undefined): boolean {
  return plan?.kind === "view"
}

/** The write query a view's own edits carry: the server moves them into the
 * source's cells and writes the source's rows. Empty for a plan. */
export function viaQuery(plan: Pick<FloorPlan, "id" | "kind"> | undefined) {
  return plan && isLiveView(plan) ? `?via=${encodeURIComponent(plan.id)}` : ""
}

/** Where the source's background image spans in a view's cells: the whole
 * source grid, shifted by the crop. Null for a plan (the image spans its
 * own grid). */
export function viewBackgroundFrame(
  plan: Pick<FloorPlan, "kind" | "snapshot">
): { x: number; y: number; width: number; height: number } | null {
  const s = plan.snapshot
  if (!isLiveView(plan) || !s?.crop || !s.source_grid) return null
  return {
    x: -s.crop.x,
    y: -s.crop.y,
    width: s.source_grid.width,
    height: s.source_grid.height,
  }
}

/** The rows a view shows but cannot edit: those crossing its edge. */
export function edgeIds(
  contents: Partial<FloorPlanContents> | undefined
): Set<string> {
  const out = new Set<string>()
  if (!contents) return out
  for (const rows of [
    contents.tiles,
    contents.areas,
    contents.labels,
    contents.walls,
    contents.trays,
    contents.raised_floors,
  ])
    for (const r of rows ?? [])
      if ((r as { crosses_edge?: boolean }).crosses_edge) out.add(r.id)
  return out
}

/** What the header says a snapshot is: "View of HQ · Floor 2", or "Copy of
 * HQ · Floor 2 · <date>" with the date in `formatDate` (the shared
 * formatter). Null for a plan made otherwise. */
export function snapshotLabel(
  plan: Pick<FloorPlan, "kind" | "snapshot">,
  formatDate: (iso: string) => string = (iso) => iso.slice(0, 10)
): string | null {
  const s = plan.snapshot
  if (!s) return null
  const src = s.source
  const name = src
    ? src.stack && src.stack !== src.name
      ? `${src.stack} · ${src.name}`
      : src.name
    : "a deleted plan"
  if (s.kind === "view") return `View of ${name}`
  return s.at ? `Copy of ${name} · ${formatDate(s.at)}` : `Copy of ${name}`
}
