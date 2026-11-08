import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  CablePathUpsert,
  CablePlanPreview,
  CablePlanRow,
  FloorPlanBulkResult,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Loading } from "@/components/loading"
import { PanelShell } from "@/components/map-panel"
import { QueryError } from "@/components/query-error"

import { formatMetres, pathRoute } from "./cable-draw"
import type { CableRoute } from "./cable-draw"
import { floorPlanContentsKey } from "./use-floor-plan-data"

/** What a row of the panel writes when ticked. */
interface RowChoice {
  route: boolean
  length: boolean
}

/** The default ticks: a route that is new, out of date or different from
 * the stored one; its length when that may be filled without replacing a
 * length a person entered. */
export function defaultChoice(row: CablePlanRow): RowChoice {
  if (!row.route || !row.can_change) return { route: false, length: false }
  const changed =
    !row.path ||
    !!row.path.stale ||
    row.path.length_mm !== row.route.length_mm ||
    row.path.tray_order.join() !== row.route.tray_order.join()
  return { route: changed, length: changed && row.write_length }
}

/** The bulk/ upsert a ticked row saves: the previewed geometry, measured
 * again on the server, against the stored path's version. */
export function upsertOf(
  row: CablePlanRow,
  choice: RowChoice
): CablePathUpsert {
  const route = row.route!
  return {
    cable: row.id,
    kind: route.kind,
    legs: route.legs.map((l) => ({ points: l.points })),
    tray_order: route.tray_order,
    ...(row.path?.version ? { version: row.path.version } : {}),
    ...(choice.length
      ? row.write_length
        ? { write_length: true }
        : { replace_length: true }
      : {}),
  }
}

function deltaText(mm: number | null): string | null {
  if (mm == null || Math.abs(mm) < 50) return null
  return `${mm > 0 ? "+" : "−"}${formatMetres(Math.abs(mm) / 1000)}`
}

/**
 * Document routes on this plan: the server routes every cable with both
 * ends here (cable-plan/), each route drawn on the plan as a preview, with
 * its length against the stored one. The ticked rows are saved as the
 * cables' stored paths (bulk/), and their lengths when ticked - a length a
 * person entered only by its own tick.
 */
export function DocumentRoutesPanel({
  planId,
  tiles,
  trays,
  onPreviews,
  onClose,
}: {
  planId: string
  tiles: readonly FloorPlanTile[]
  trays: readonly FloorPlanTray[]
  /** The ticked rows' routes, for the canvas to draw as previews. */
  onPreviews: (routes: ReadonlyMap<string, CableRoute> | undefined) => void
  onClose: () => void
}) {
  const qc = useQueryClient()
  const preview = useQuery({
    queryKey: ["floor-plan-cable-plan", planId],
    queryFn: () =>
      api<CablePlanPreview>(`/api/floor-plans/${planId}/cable-plan/`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    staleTime: 0,
    gcTime: 0,
  })
  const rows = useMemo(() => preview.data?.cables ?? [], [preview.data])
  const [choices, setChoices] = useState<Record<string, RowChoice>>({})
  useEffect(() => {
    setChoices(Object.fromEntries(rows.map((r) => [r.id, defaultChoice(r)])))
  }, [rows])

  const trayName = useMemo(
    () => new Map(trays.map((t) => [t.id, t.name])),
    [trays]
  )
  const routes = useMemo(() => {
    const tileById = new Map(tiles.map((t) => [t.id, t]))
    const trayById = new Map(trays.map((t) => [t.id, t]))
    const out = new Map<string, CableRoute>()
    for (const row of rows) {
      if (!row.route || !choices[row.id]?.route) continue
      const r = pathRoute(row.id, row.route, tileById, trayById)
      if (r) out.set(row.id, r)
    }
    return out
  }, [rows, choices, tiles, trays])
  useEffect(() => {
    onPreviews(routes.size ? routes : undefined)
  }, [routes, onPreviews])
  useEffect(() => () => onPreviews(undefined), [onPreviews])

  const ticked = rows.filter((r) => r.route && choices[r.id]?.route)
  const save = useMutation({
    mutationFn: () =>
      api<FloorPlanBulkResult>(`/api/floor-plans/${planId}/bulk/`, {
        method: "POST",
        body: JSON.stringify({
          cable_paths: {
            upsert: ticked.map((r) => upsertOf(r, choices[r.id])),
          },
        }),
      }),
    onSuccess: (res) => {
      const n = res.cable_paths?.length ?? 0
      toast.success(n === 1 ? "1 route documented" : `${n} routes documented`)
      qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths", planId] })
      // Tray membership follows the routes: the trays list their cables.
      qc.invalidateQueries({ queryKey: floorPlanContentsKey(planId) })
      onClose()
    },
    onError: (e) => apiErrorToast(e, "Could not save the routes"),
  })

  const set = (id: string, patch: Partial<RowChoice>) =>
    setChoices((c) => ({ ...c, [id]: { ...c[id], ...patch } }))

  const data = preview.data
  return (
    <PanelShell
      label="Document routes"
      title="Document routes"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          disabled={!ticked.length || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending
            ? "Saving…"
            : ticked.length === 1
              ? "Save 1 route"
              : `Save ${ticked.length} routes`}
        </Button>
      }
    >
      {preview.isLoading && <Loading />}
      {preview.isError && <QueryError error={preview.error} />}
      {data && (
        <>
          <p className="text-[11px] text-muted-foreground">
            1 cell = {data.cell_mm} mm
          </p>
          {data.scale_source === "assumed" && (
            <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
              Drawing not calibrated - lengths may be wrong
            </p>
          )}
          {!rows.length && (
            <p className="mt-2 text-muted-foreground">
              No cable has both ends on this plan.
            </p>
          )}
          <ul className="mt-2 grid gap-2">
            {rows.map((row) => {
              const c = choices[row.id] ?? { route: false, length: false }
              const r = row.route
              const via = r
                ? r.tray_order.length
                  ? r.tray_order
                      .map((id) => trayName.get(id) ?? "Tray")
                      .join(" → ")
                  : "Direct"
                : row.reason
              const delta = deltaText(row.delta_mm)
              return (
                <li key={row.id} className="rounded-md border px-2 py-1.5">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={c.route}
                      disabled={!r || !row.can_change}
                      onCheckedChange={(v) =>
                        set(row.id, {
                          route: v === true,
                          length: v === true && c.length,
                        })
                      }
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {row.label}
                    </span>
                    {row.path?.stale && (
                      <Badge variant="warning">Out of date</Badge>
                    )}
                    {r && (
                      <span className="num">
                        {formatMetres(r.length_mm / 1000)}
                      </span>
                    )}
                  </label>
                  <div className="mt-0.5 flex items-center gap-2 pl-6 text-[11px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">{via}</span>
                    {row.length != null && (
                      <span className="num whitespace-nowrap">
                        {+row.length.toFixed(2)} {row.length_unit}
                        {delta && ` (${delta})`}
                      </span>
                    )}
                  </div>
                  {r && row.can_change && (
                    <label className="mt-1 flex items-center gap-2 pl-6 text-[11px] whitespace-nowrap">
                      <Checkbox
                        checked={c.length}
                        disabled={!c.route}
                        onCheckedChange={(v) =>
                          set(row.id, { length: v === true })
                        }
                      />
                      {row.write_length
                        ? "Set length"
                        : "Replace measured length"}
                    </label>
                  )}
                </li>
              )
            })}
          </ul>
          {data.truncated && (
            <p className="mt-2 text-[11px] text-muted-foreground">
              The first {rows.length} cables
            </p>
          )}
        </>
      )}
    </PanelShell>
  )
}
