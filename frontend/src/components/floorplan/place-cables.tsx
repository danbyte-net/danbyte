import { useEffect, useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { X } from "lucide-react"

import { api } from "@/lib/api"
import type {
  CablePlanPreview,
  CablePlanRequest,
  CablePlanRow,
  CablePlanSuggestion,
  CablePlanVia,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"
import { ColorBadge } from "@/components/cells/color-badge"
import { Loading } from "@/components/loading"
import { PanelShell } from "@/components/map-panel"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

import { defaultTicks } from "./cable-draft"
import type { RouteTicks } from "./cable-draft"
import { formatMetres, pathRoute } from "./cable-draw"
import type { CableRoute } from "./cable-draw"
import type { RoomPromptState } from "./placement-panels"

/** What was just placed, and the draft as it was then (the preview routes
 * against it), with the room it may be set to. */
export interface AfterPlace {
  objects: { kind: "device" | "rack" | "cabinet"; id: string; name: string }[]
  input: Pick<
    CablePlanRequest,
    "positions" | "new_tiles" | "removed_tiles" | "draft_trays"
  >
  room: RoomPromptState | null
}

/** How a row is routed: through the trays (auto), the trays picked, a
 * suggested run or a direct elbow. */
export interface RowMode {
  via: "auto" | CablePlanVia
  trayIds?: string[]
}

/** The preview request for the placed objects' cables. */
export function placeCablesRequest(
  after: AfterPlace,
  modes: Readonly<Partial<Record<string, RowMode>>> = {},
  keepRuns = true
): CablePlanRequest {
  const choices: NonNullable<CablePlanRequest["choices"]> = {}
  for (const [id, m] of Object.entries(modes)) {
    if (!m || m.via === "auto") continue
    choices[id] =
      m.via === "trays"
        ? { via: "trays", tray_ids: m.trayIds ?? [] }
        : { via: m.via }
  }
  return {
    objects: after.objects.map(({ kind, id }) => ({ kind, id })),
    ...after.input,
    ...(Object.keys(choices).length ? { choices } : {}),
    ...(keepRuns ? {} : { keep_runs: false }),
  }
}

/** The preview of the placed objects' cables (cable-plan/). */
export function usePlacedCables(
  planId: string,
  request: CablePlanRequest | null
) {
  return useQuery({
    queryKey: ["floor-plan-cable-plan", planId, "placed", request],
    queryFn: () =>
      api<CablePlanPreview>(`/api/floor-plans/${planId}/cable-plan/`, {
        method: "POST",
        body: JSON.stringify(request),
      }),
    enabled: !!request && request.objects!.length > 0,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

/** The rows a panel can route: a route, a cable the user may change. */
export const routableRows = (rows: readonly CablePlanRow[]) =>
  rows.filter((r) => r.route && r.can_change && !r.off_floor)

/**
 * **After placing**: over the plan after a drop - the room the objects
 * stand in, and their cables to objects already on this floor. One card,
 * nothing changes until a button is clicked.
 */
export function AfterPlacingCard({
  room,
  roomBusy,
  onSetRoom,
  cables,
  onRouteCables,
  onDismiss,
}: {
  room: RoomPromptState | null
  roomBusy: boolean
  onSetRoom: () => void
  /** Cables that may be routed; 0 hides the row. */
  cables: number
  onRouteCables: () => void
  onDismiss: () => void
}) {
  if (!room && !cables) return null
  const n = room?.objects.length ?? 0
  return (
    <div
      role="status"
      data-part="after-placing"
      className="pointer-events-auto absolute top-3 left-1/2 z-20 flex -translate-x-1/2 items-start gap-2 rounded-lg border border-border bg-popover px-3 py-1.5 text-sm shadow-md"
    >
      <div className="flex flex-col gap-1.5">
        {room && (
          <div data-part="room-prompt" className="flex items-center gap-2">
            <span className="whitespace-nowrap">
              {n === 1 ? room.objects[0].name : `${n} objects`}: set room to
            </span>
            <ColorBadge name={room.room.name} color={room.room.color} />
            <Button
              size="sm"
              className="h-7"
              disabled={roomBusy}
              onClick={onSetRoom}
            >
              {roomBusy ? "Setting…" : "Set room"}
            </Button>
          </div>
        )}
        {cables > 0 && (
          <div data-part="place-cables" className="flex items-center gap-2">
            <span className="whitespace-nowrap">
              {cables === 1 ? "1 cable" : `${cables} cables`} to objects on this
              floor
            </span>
            <Button size="sm" className="h-7" onClick={onRouteCables}>
              {cables === 1 ? "Route 1 cable" : `Route ${cables} cables`}
            </Button>
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  )
}

function deltaText(mm: number | null): string | null {
  if (mm == null || Math.abs(mm) < 50) return null
  return `${mm > 0 ? "+" : "−"}${formatMetres(Math.abs(mm) / 1000)}`
}

function farText(row: CablePlanRow): string {
  const ends = row.far ?? []
  if (!ends.length) return ""
  return ends
    .map((e) =>
      e.hidden ? "Hidden" : [e.device_name, e.port].filter(Boolean).join(" · ")
    )
    .join(", ")
}

/** A suggested run drawn as a tray, so the previews lane along it. */
function suggestionTray(s: CablePlanSuggestion): FloorPlanTray {
  return {
    id: s.key,
    name: "Suggested run",
    kind: "",
    color: "",
    points: s.run ?? s.points,
    level: s.level,
    elevation_mm: s.elevation_mm,
    description: "",
    cables: [],
    hidden_cable_count: 0,
    created_at: "",
    updated_at: "",
  }
}

const VIA_TABS: { value: "trays" | "suggest" | "direct"; label: string }[] = [
  { value: "trays", label: "Pick trays" },
  { value: "suggest", label: "Suggest a run" },
  { value: "direct", label: "Direct" },
]

/** What "Apply" hands the editor: the rows, their ticks, the runs. */
export interface PlaceCablesApply {
  rows: CablePlanRow[]
  ticks: Partial<Record<string, RouteTicks>>
  suggestions: CablePlanSuggestion[]
}

/**
 * Route the cables of what was just placed: each cable's route to its far
 * end on this floor, previewed on the plan, with its length against the
 * stored one. A cable no tray serves is routed through trays picked on
 * the plan, along a suggested run (kept as a new tray unless unticked), or
 * direct. **Apply** puts the ticked rows in the draft - one undo step -
 * and the plan's Save writes them.
 */
export function PlaceCablesPanel({
  planId,
  after,
  tiles,
  trays,
  onPreviews,
  onTrayPick,
  onApply,
  onClose,
}: {
  planId: string
  after: AfterPlace
  /** The tiles as the draft holds them. */
  tiles: readonly FloorPlanTile[]
  /** The plan's trays with the draft's. */
  trays: readonly FloorPlanTray[]
  onPreviews: (routes: ReadonlyMap<string, CableRoute> | undefined) => void
  /** Picking trays on the plan for a row, or done. */
  onTrayPick: (
    pick:
      { picked: readonly string[]; onPick: (id: string) => void } | undefined
  ) => void
  onApply: (apply: PlaceCablesApply) => void
  onClose: () => void
}) {
  const [modes, setModes] = useState<Partial<Record<string, RowMode>>>({})
  const [keepRuns, setKeepRuns] = useState(true)
  const [pickFor, setPickFor] = useState<string | null>(null)
  const request = useMemo(
    () => placeCablesRequest(after, modes, keepRuns),
    [after, modes, keepRuns]
  )
  const preview = usePlacedCables(planId, request)
  const data = preview.data
  const rows = useMemo(() => data?.cables ?? [], [data])
  const suggestions = useMemo(() => data?.suggestions ?? [], [data])
  const routed = rows.filter((r) => !r.off_floor)
  const leaving = rows.filter((r) => r.off_floor)

  // The ticks: the user's where they ticked, else each row's default.
  const [userTicks, setUserTicks] = useState<
    Partial<Record<string, RouteTicks>>
  >({})
  const ticks = useMemo<Partial<Record<string, RouteTicks>>>(
    () =>
      Object.fromEntries(
        rows.map((r) => [r.id, userTicks[r.id] ?? defaultTicks(r)])
      ),
    [rows, userTicks]
  )
  const set = (id: string, patch: Partial<RouteTicks>) =>
    setUserTicks((t) => ({
      ...t,
      [id]: { route: false, length: false, ...ticks[id], ...patch },
    }))

  // Rows no tray serves (in auto) keep their choice of route on show.
  const [noTrayPath, setNoTrayPath] = useState<Set<string>>(new Set())
  useEffect(() => {
    setNoTrayPath((prev) => {
      const add = rows.filter(
        (r) => r.route && r.via === "direct" && !modes[r.id] && !prev.has(r.id)
      )
      return add.length ? new Set([...prev, ...add.map((r) => r.id)]) : prev
    })
  }, [rows, modes])

  const trayName = useMemo(
    () => new Map(trays.map((t) => [t.id, t.name])),
    [trays]
  )
  const routes = useMemo(() => {
    const tileById = new Map(tiles.map((t) => [t.id, t]))
    const trayById = new Map<string, FloorPlanTray>(trays.map((t) => [t.id, t]))
    for (const s of suggestions) trayById.set(s.key, suggestionTray(s))
    const out = new Map<string, CableRoute>()
    for (const row of rows) {
      if (!row.route || !ticks[row.id]?.route) continue
      const r = pathRoute(row.id, row.route, tileById, trayById)
      if (r) out.set(row.id, r)
    }
    return out
  }, [rows, ticks, tiles, trays, suggestions])
  useEffect(() => {
    onPreviews(routes.size ? routes : undefined)
  }, [routes, onPreviews])
  useEffect(() => () => onPreviews(undefined), [onPreviews])

  // Picking trays for a row: a click on the plan adds or takes away one.
  const picked = pickFor ? (modes[pickFor]?.trayIds ?? []) : null
  useEffect(() => {
    if (!pickFor || !picked) {
      onTrayPick(undefined)
      return
    }
    onTrayPick({
      picked,
      onPick: (id) =>
        setModes((m) => {
          const cur = m[pickFor]?.trayIds ?? []
          return {
            ...m,
            [pickFor]: {
              via: "trays",
              trayIds: cur.includes(id)
                ? cur.filter((t) => t !== id)
                : [...cur, id],
            },
          }
        }),
    })
  }, [pickFor, picked?.join(), onTrayPick])
  useEffect(() => () => onTrayPick(undefined), [onTrayPick])

  const setVia = (id: string, via: "trays" | "suggest" | "direct") => {
    setModes((m) => ({
      ...m,
      [id]: via === "trays" ? { via, trayIds: m[id]?.trayIds ?? [] } : { via },
    }))
    setPickFor(via === "trays" ? id : null)
  }
  const suggestAll = () => {
    setModes((m) => {
      const next = { ...m }
      for (const id of noTrayPath)
        if (!next[id] || next[id].via === "direct")
          next[id] = { via: "suggest" }
      return next
    })
    setPickFor(null)
  }
  const unrouted = [...noTrayPath].filter(
    (id) => (modes[id]?.via ?? "auto") === "auto"
  )
  const anySuggested = routed.some((r) => r.via === "suggest")
  const ticked = routed.filter((r) => r.route && ticks[r.id]?.route)

  const viaText = (row: CablePlanRow) => {
    const r = row.route
    if (!r) return row.reason
    if (row.via === "suggest")
      return r.kind === "trays" && keepRuns ? "Suggested run" : "Suggested path"
    if (!r.tray_order.length) return "Direct"
    return r.tray_order.map((id) => trayName.get(id) ?? "Tray").join(" → ")
  }

  return (
    <PanelShell
      label="Route cables"
      title="Route cables"
      onClose={onClose}
      footer={
        <Button
          size="sm"
          disabled={!ticked.length || preview.isFetching}
          onClick={() => onApply({ rows: routed, ticks, suggestions })}
        >
          {ticked.length === 1
            ? "Apply 1 route"
            : `Apply ${ticked.length} routes`}
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
            <p
              data-part="scale-assumed"
              className="mt-1 text-[11px] text-amber-700 dark:text-amber-300"
            >
              Drawing not calibrated - lengths may be wrong
            </p>
          )}
          {unrouted.length > 0 && (
            <div className="mt-2 flex items-center gap-2 rounded-md border px-2 py-1.5">
              <span className="min-w-0 flex-1 text-[11px] whitespace-nowrap">
                {unrouted.length === 1
                  ? "1 cable has no tray path"
                  : `${unrouted.length} cables have no tray path`}
              </span>
              <Button size="sm" className="h-7" onClick={suggestAll}>
                Suggest runs
              </Button>
            </div>
          )}
          {anySuggested && (
            <label className="mt-2 flex items-center gap-2 text-[11px] whitespace-nowrap">
              <Checkbox
                checked={keepRuns}
                onCheckedChange={(v) => setKeepRuns(v === true)}
              />
              Keep as a tray
            </label>
          )}
          <ul className="mt-2 grid gap-2">
            {routed.map((row) => {
              const c = ticks[row.id] ?? { route: false, length: false }
              const r = row.route
              const delta = deltaText(row.delta_mm)
              const far = farText(row)
              const mode = modes[row.id]?.via ?? "auto"
              const choosing = noTrayPath.has(row.id) || mode !== "auto"
              return (
                <li
                  key={row.id}
                  data-row={row.id}
                  className="rounded-md border px-2 py-1.5"
                >
                  <label className="flex items-center gap-2">
                    <Checkbox
                      aria-label={`Route ${row.label}`}
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
                    {r && (
                      <span className="num">
                        {formatMetres(r.length_mm / 1000)}
                      </span>
                    )}
                  </label>
                  <div className="mt-0.5 flex items-center gap-2 pl-6 text-[11px] text-muted-foreground">
                    <span className="min-w-0 flex-1 truncate">
                      {far ? `${far} · ` : ""}
                      {viaText(row)}
                    </span>
                    {row.length != null && (
                      <span className="num whitespace-nowrap">
                        {+row.length.toFixed(2)} {row.length_unit}
                        {delta && ` (${delta})`}
                      </span>
                    )}
                  </div>
                  {choosing && row.can_change && (
                    <div className="mt-1 pl-6">
                      <SegmentedTabs
                        value={mode === "auto" ? "direct" : mode}
                        onValueChange={(v) => setVia(row.id, v)}
                        items={VIA_TABS}
                      />
                      {pickFor === row.id && (
                        <div
                          data-part="tray-pick"
                          className="mt-1 flex items-center gap-2 text-[11px]"
                        >
                          <span className="min-w-0 flex-1 truncate text-muted-foreground">
                            {picked?.length
                              ? picked
                                  .map((id) => trayName.get(id) ?? "Tray")
                                  .join(" → ")
                              : "Click trays on the plan"}
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6"
                            onClick={() => setPickFor(null)}
                          >
                            Done
                          </Button>
                        </div>
                      )}
                      {mode === "trays" &&
                        pickFor !== row.id &&
                        r &&
                        !r.tray_order.length &&
                        !!modes[row.id]?.trayIds?.length && (
                          <Badge variant="warning" className="mt-1">
                            Trays do not connect
                          </Badge>
                        )}
                    </div>
                  )}
                  {r && row.can_change && (
                    <label className="mt-1 flex items-center gap-2 pl-6 text-[11px] whitespace-nowrap">
                      <Checkbox
                        aria-label={`Length of ${row.label}`}
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
          {leaving.length > 0 && (
            <div className="mt-3">
              <p className="text-[11px] font-medium text-muted-foreground">
                Leaves this floor
              </p>
              <ul className="mt-1 grid gap-1">
                {leaving.map((row) => (
                  <li
                    key={row.id}
                    data-off-floor={row.id}
                    className="truncate text-[11px] text-muted-foreground"
                  >
                    {row.label}
                    {farText(row) ? ` · ${farText(row)}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </PanelShell>
  )
}
