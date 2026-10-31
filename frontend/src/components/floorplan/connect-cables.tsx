import { useEffect, useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Pencil, X } from "lucide-react"

import { api } from "@/lib/api"
import type {
  CablePlanSuggestion,
  ConnectFamily,
  ConnectPair,
  ConnectPort,
  ConnectPreview,
  ConnectRequest,
  FloorPlanTile,
  FloorPlanTray,
} from "@/lib/api"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { FormColor, FormCombobox, FormStatusSelect } from "@/components/forms"
import { Loading } from "@/components/loading"
import { PanelShell } from "@/components/map-panel"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Combobox } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"

import type { DraftPlanInput, DraftNewCable } from "./cable-draft"
import { formatMetres, pathRoute } from "./cable-draw"
import type { CableRoute } from "./cable-draw"
import { roomAreaAt } from "./placement"
import type { PlanShape } from "./shapes"
import { shownLink } from "./shown-link"

type ObjKind = "device" | "rack" | "cabinet"

/** What new cables run from: placed objects, each by its tile. */
export interface ConnectSource {
  kind: ObjKind
  id: string
  name: string
  tileId: string
}

/** A tile Connect to… may connect to. */
export interface ConnectCandidate {
  tileId: string
  kind: ObjKind
  id: string
  name: string
  /** In the same room area as the first source. */
  sameRoom: boolean
  /** Centre to centre, in cells. */
  distance: number
}

const centre = (t: FloorPlanTile): [number, number] => [
  t.x + t.width / 2,
  t.y + t.height / 2,
]

/** The tile's object, when it is a device, rack or cabinet the reader may
 * view - nothing else is ever offered. */
export function connectable(
  t: FloorPlanTile
): { kind: ObjKind; id: string; name: string } | null {
  const l = shownLink(t.linked)
  if (!l || (l.kind !== "device" && l.kind !== "rack" && l.kind !== "cabinet"))
    return null
  return { kind: l.kind, id: l.id, name: l.name }
}

/** The objects on this floor the sources may connect to: placed devices,
 * racks and cabinets (never hidden ones, never the sources), those in the
 * same room area first, then the nearest. */
export function connectCandidates(
  tiles: readonly FloorPlanTile[],
  shapes: PlanShape[],
  sources: readonly ConnectSource[]
): ConnectCandidate[] {
  const own = new Set(sources.map((s) => s.tileId))
  const first = tiles.find((t) => t.id === sources[0]?.tileId)
  const from = first ? centre(first) : null
  const room = from ? (roomAreaAt(shapes, from)?.id ?? null) : null
  const out: ConnectCandidate[] = []
  for (const t of tiles) {
    if (own.has(t.id)) continue
    const o = connectable(t)
    if (!o) continue
    const c = centre(t)
    out.push({
      tileId: t.id,
      ...o,
      sameRoom: room != null && roomAreaAt(shapes, c)?.id === room,
      distance: from ? Math.hypot(c[0] - from[0], c[1] - from[1]) : 0,
    })
  }
  return out.sort(
    (a, b) =>
      Number(b.sameRoom) - Number(a.sameRoom) ||
      a.distance - b.distance ||
      a.name.localeCompare(b.name, undefined, { numeric: true })
  )
}

type PortRef = { kind: string; id: string }
type PairRef = { key: string; a: PortRef; b: PortRef }

const ref = (p: ConnectPort): PortRef => ({ kind: p.kind, id: p.id })
const refKey = (p: PortRef) => `${p.kind}:${p.id}`

/** "1 Gbps · copper" - what a port is, for the pickers. */
export function portHint(p: ConnectPort): string {
  const speed =
    p.speed_mbps == null
      ? ""
      : p.speed_mbps >= 1000
        ? `${+(p.speed_mbps / 1000).toFixed(1)} Gbps`
        : `${p.speed_mbps} Mbps`
  const media = p.media === "cage" ? p.connector.toUpperCase() : p.media
  return [speed, media, p.uplink ? "uplink" : ""].filter(Boolean).join(" · ")
}

/** The request for the sources to the targets, against the draft. */
export function connectRequest({
  sources,
  targets,
  family,
  perTarget,
  includeMgmt,
  taken,
  input,
  pairs,
  suggestRuns,
  keepRuns,
}: {
  sources: readonly ConnectSource[]
  targets: readonly { kind: ObjKind; id: string }[]
  family: ConnectFamily
  perTarget: number
  includeMgmt: boolean
  taken: readonly PortRef[]
  input: DraftPlanInput
  pairs: readonly PairRef[] | null
  suggestRuns: boolean
  keepRuns: boolean
}): ConnectRequest {
  return {
    mode: "new",
    source: sources.map(({ kind, id }) => ({ kind, id })),
    targets: targets.map(({ kind, id }) => ({ kind, id })),
    family,
    per_target: perTarget,
    ...(includeMgmt ? { include_mgmt: true } : {}),
    ...(taken.length ? { exclude_ports: [...taken] } : {}),
    ...input,
    ...(pairs ? { pairs: [...pairs] } : {}),
    ...(suggestRuns ? { suggest_runs: true } : {}),
    ...(keepRuns ? {} : { keep_runs: false }),
  }
}

/** One end of a pair, changed with a picker of the device's free ports
 * that fit the other end. */
function PortPicker({
  planId,
  port,
  other,
  family,
  includeMgmt,
  exclude,
  onChange,
}: {
  planId: string
  port: ConnectPort
  other: ConnectPort
  family: ConnectFamily
  includeMgmt: boolean
  exclude: readonly PortRef[]
  onChange: (p: ConnectPort) => void
}) {
  const params = new URLSearchParams({
    device: port.device,
    family,
    for: refKey(other),
  })
  if (includeMgmt) params.set("include_mgmt", "1")
  if (exclude.length) params.set("exclude", exclude.map(refKey).join(","))
  const q = useQuery({
    queryKey: ["floor-plan-connect-ports", planId, params.toString()],
    queryFn: () =>
      api<{ ports: ConnectPort[] }>(
        `/api/floor-plans/${planId}/cable-plan/ports/?${params}`
      ),
    staleTime: 30_000,
  })
  const ports = [
    port,
    ...(q.data?.ports ?? []).filter((p) => refKey(p) !== refKey(port)),
  ]
  return (
    <Combobox
      value={refKey(port)}
      onChange={(v) => {
        const p = ports.find((x) => refKey(x) === v)
        if (p) onChange(p)
      }}
      options={ports.map((p) => ({
        value: refKey(p),
        label: p.name,
        hint: portHint(p),
      }))}
      searchPlaceholder={`Search ${port.device_name}…`}
      emptyText="No free ports fit."
    />
  )
}

/** What "Add cables" hands the editor: the pairs to make and how. */
export interface ConnectApply {
  pairs: ConnectPair[]
  type: string | null
  color: string
  status: DraftNewCable["status"]
  suggestions: CablePlanSuggestion[]
}

const FAMILY_TABS: { value: ConnectFamily; label: string }[] = [
  { value: "data", label: "Network" },
  { value: "console", label: "Console" },
  { value: "power", label: "Power" },
]

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

/**
 * **Connect to…**: plan new cables from the sources to objects on this
 * floor. Pick the targets on the plan or from the list (same room first,
 * then the nearest); Danbyte proposes free, compatible port pairs, which
 * can be changed or dropped; the cables preview on the plan as planned
 * runs with their lengths. **Add cables** puts them in the draft - one
 * undo step - and the plan's Save makes them, all or nothing.
 */
export function ConnectCablesPanel({
  planId,
  sources,
  tiles,
  shapes,
  trays,
  input,
  taken = [],
  onTilePick,
  onPreviews,
  onApply,
  onClose,
}: {
  planId: string
  sources: readonly ConnectSource[]
  /** The tiles as the draft holds them. */
  tiles: readonly FloorPlanTile[]
  shapes: PlanShape[]
  /** The plan's trays with the draft's. */
  trays: readonly FloorPlanTray[]
  input: DraftPlanInput
  /** Ports the draft's new cables already take. */
  taken?: readonly PortRef[]
  /** Picking targets on the plan (a click on a tile), or done. */
  onTilePick: (
    pick:
      | { picked: ReadonlySet<string>; onPick: (tile: FloorPlanTile) => void }
      | undefined
  ) => void
  onPreviews: (routes: ReadonlyMap<string, CableRoute> | undefined) => void
  onApply: (apply: ConnectApply) => void
  onClose: () => void
}) {
  const candidates = useMemo(
    () => connectCandidates(tiles, shapes, sources),
    [tiles, shapes, sources]
  )
  const [targets, setTargets] = useState<string[]>([])
  const [picking, setPicking] = useState(true)
  const [search, setSearch] = useState("")
  const [family, setFamily] = useState<ConnectFamily>("data")
  const [perTarget, setPerTarget] = useState(1)
  const [includeMgmt, setIncludeMgmt] = useState(false)
  const [edited, setEdited] = useState<PairRef[] | null>(null)
  const [dropped, setDropped] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const [suggestRuns, setSuggestRuns] = useState(false)
  const [keepRuns, setKeepRuns] = useState(true)
  const [type, setType] = useState<string | null>(null)
  const [color, setColor] = useState("")
  const [statusId, setStatusId] = useState<string | null>(null)
  const choices = useDcimChoices()

  const byTile = useMemo(
    () => new Map(candidates.map((c) => [c.tileId, c])),
    [candidates]
  )
  const picked = targets
    .map((t) => byTile.get(t))
    .filter((c): c is ConnectCandidate => !!c)
  // A new set of targets or a new kind of cable: proposed afresh.
  const reset = () => {
    setEdited(null)
    setDropped(new Set())
    setEditing(null)
  }
  const toggle = (tileId: string) => {
    if (!byTile.has(tileId)) return
    reset()
    setTargets((ts) =>
      ts.includes(tileId) ? ts.filter((t) => t !== tileId) : [...ts, tileId]
    )
  }

  // Clicking tiles on the plan picks targets.
  const pickedKey = targets.join()
  useEffect(() => {
    if (!picking) {
      onTilePick(undefined)
      return
    }
    onTilePick({
      picked: new Set(targets),
      onPick: (tile) => toggle(tile.id),
    })
  }, [picking, pickedKey, byTile, onTilePick])
  useEffect(() => () => onTilePick(undefined), [onTilePick])

  const request = useMemo(
    () =>
      picked.length
        ? connectRequest({
            sources,
            targets: picked,
            family,
            perTarget,
            includeMgmt,
            taken,
            input,
            pairs: edited,
            suggestRuns,
            keepRuns,
          })
        : null,
    [
      pickedKey,
      sources,
      family,
      perTarget,
      includeMgmt,
      taken,
      input,
      edited,
      suggestRuns,
      keepRuns,
    ]
  )
  const preview = useQuery({
    queryKey: ["floor-plan-connect", planId, request],
    queryFn: () =>
      api<ConnectPreview>(`/api/floor-plans/${planId}/cable-plan/`, {
        method: "POST",
        body: JSON.stringify(request),
      }),
    enabled: !!request,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  const data = request ? preview.data : undefined
  const pairs = useMemo(() => data?.pairs ?? [], [data])
  const kept = pairs.filter((p) => !dropped.has(p.key) && !p.error)
  const statuses = data?.statuses ?? []
  const status =
    statuses.find((s) => s.id === statusId) ??
    (statuses.length ? statuses[0] : null)

  // The kept pairs drawn on the plan as previews.
  const routes = useMemo(() => {
    const tileById = new Map(tiles.map((t) => [t.id, t]))
    const trayById = new Map<string, FloorPlanTray>(trays.map((t) => [t.id, t]))
    for (const s of data?.suggestions ?? [])
      trayById.set(s.key, suggestionTray(s))
    const out = new Map<string, CableRoute>()
    for (const p of pairs) {
      if (dropped.has(p.key) || p.error || !p.route) continue
      const r = pathRoute(p.key, p.route, tileById, trayById)
      if (r) out.set(p.key, r)
    }
    return out
  }, [pairs, dropped, tiles, trays, data])
  useEffect(() => {
    onPreviews(routes.size ? routes : undefined)
  }, [routes, onPreviews])
  useEffect(() => () => onPreviews(undefined), [onPreviews])

  /** The pairs as sent once the user edits them. */
  const current = (): PairRef[] =>
    edited ??
    pairs
      .filter((p) => !dropped.has(p.key))
      .map((p) => ({ key: p.key, a: ref(p.a), b: ref(p.b) }))
  const setPort = (key: string, side: "a" | "b", port: ConnectPort) =>
    setEdited(
      current().map((p) => (p.key === key ? { ...p, [side]: ref(port) } : p))
    )
  const drop = (key: string) => {
    setDropped((d) => new Set([...d, key]))
    if (edited) setEdited(edited.filter((p) => p.key !== key))
    if (editing === key) setEditing(null)
  }
  // Ports a picker leaves out: the draft's and the other pairs'.
  const usedBy = (key: string) => [
    ...taken,
    ...kept.filter((p) => p.key !== key).flatMap((p) => [ref(p.a), ref(p.b)]),
  ]

  const shown = candidates.filter(
    (c) =>
      !search.trim() ||
      c.name.toLowerCase().includes(search.trim().toLowerCase())
  )
  const noTrayPath = kept.some((p) => p.route && p.via === "direct")
  const anySuggested = kept.some((p) => p.via === "suggest")
  const title =
    sources.length === 1
      ? `Connect ${sources[0].name} to…`
      : `Connect ${sources.length} objects to…`
  const canApply = !!data?.can_add && !!status && kept.length > 0

  return (
    <PanelShell
      label="Connect to"
      title={title}
      onClose={onClose}
      footer={
        <Button
          size="sm"
          disabled={!canApply || preview.isFetching}
          onClick={() =>
            status &&
            onApply({
              pairs: kept,
              type,
              color,
              status,
              suggestions: data?.suggestions ?? [],
            })
          }
        >
          {kept.length === 1 ? "Add 1 cable" : `Add ${kept.length} cables`}
        </Button>
      }
    >
      <section data-part="connect-targets" className="grid gap-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 text-[11px] font-medium text-muted-foreground">
            Targets
          </span>
          <Button
            size="sm"
            variant={picking ? "default" : "outline"}
            className="h-6"
            onClick={() => setPicking((v) => !v)}
          >
            {picking ? "Done picking" : "Pick on plan"}
          </Button>
        </div>
        {picked.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {picked.map((c) => (
              <Badge key={c.tileId} variant="secondary" className="gap-1">
                {c.name}
                <button
                  type="button"
                  aria-label={`Remove ${c.name}`}
                  onClick={() => toggle(c.tileId)}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search this floor…"
          className="h-7 text-xs"
        />
        <ul className="grid max-h-40 gap-0.5 overflow-y-auto">
          {shown.map((c) => (
            <li key={c.tileId}>
              <label className="flex items-center gap-2 text-xs whitespace-nowrap">
                <Checkbox
                  aria-label={`Connect to ${c.name}`}
                  checked={targets.includes(c.tileId)}
                  onCheckedChange={() => toggle(c.tileId)}
                />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {c.kind}
                </span>
              </label>
            </li>
          ))}
          {!shown.length && (
            <li className="text-[11px] text-muted-foreground">
              Nothing else on this floor.
            </li>
          )}
        </ul>
      </section>

      <section className="mt-3 grid gap-2">
        <SegmentedTabs
          value={family}
          onValueChange={(v) => {
            reset()
            setFamily(v)
          }}
          items={FAMILY_TABS}
        />
        <div className="flex items-center gap-3 text-xs whitespace-nowrap">
          <label className="flex items-center gap-2">
            Cables each
            <Input
              type="number"
              min={1}
              max={8}
              value={perTarget}
              onChange={(e) => {
                const n = Math.max(1, Math.min(8, Number(e.target.value) || 1))
                reset()
                setPerTarget(n)
              }}
              className="h-7 w-14 text-xs"
              aria-label="Cables to each target"
            />
          </label>
          {family === "data" && (
            <label className="flex items-center gap-2">
              <Checkbox
                checked={includeMgmt}
                onCheckedChange={(v) => {
                  reset()
                  setIncludeMgmt(v === true)
                }}
              />
              Management ports
            </label>
          )}
        </div>
      </section>

      {request && preview.isLoading && <Loading />}
      {request && preview.isError && <QueryError error={preview.error} />}
      {data && (
        <section data-part="connect-pairs" className="mt-3 grid gap-2">
          <p className="text-[11px] text-muted-foreground">
            1 cell = {data.cell_mm} mm
          </p>
          {data.scale_source === "assumed" && (
            <p className="text-[11px] text-amber-700 dark:text-amber-300">
              Drawing not calibrated - lengths may be wrong
            </p>
          )}
          {noTrayPath && !suggestRuns && (
            <div className="flex items-center gap-2 rounded-md border px-2 py-1.5">
              <span className="min-w-0 flex-1 text-[11px] whitespace-nowrap">
                No tray path for some
              </span>
              <Button
                size="sm"
                className="h-7"
                onClick={() => setSuggestRuns(true)}
              >
                Suggest runs
              </Button>
            </div>
          )}
          {anySuggested && (
            <label className="flex items-center gap-2 text-[11px] whitespace-nowrap">
              <Checkbox
                checked={keepRuns}
                onCheckedChange={(v) => setKeepRuns(v === true)}
              />
              Keep as a tray
            </label>
          )}
          <ul className="grid gap-2">
            {pairs
              .filter((p) => !dropped.has(p.key))
              .map((p) => (
                <li
                  key={p.key}
                  data-pair={p.key}
                  className="rounded-md border px-2 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">
                      {p.a.device_name} · {p.a.name} → {p.b.device_name} ·{" "}
                      {p.b.name}
                    </span>
                    {p.route && (
                      <span className="num text-xs">
                        {formatMetres(p.route.length_mm / 1000)}
                      </span>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Change ports of ${p.a.name}`}
                      onClick={() =>
                        setEditing((k) => (k === p.key ? null : p.key))
                      }
                    >
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Drop ${p.a.name}`}
                      onClick={() => drop(p.key)}
                    >
                      <X />
                    </Button>
                  </div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">
                    {p.error ? (
                      <Badge variant="destructive">{p.error}</Badge>
                    ) : p.route ? (
                      p.via === "suggest" ? (
                        "Suggested run"
                      ) : p.route.tray_order.length ? (
                        "Through trays"
                      ) : (
                        "Direct"
                      )
                    ) : (
                      p.reason
                    )}
                  </div>
                  {editing === p.key && (
                    <div className="mt-1 grid gap-1">
                      <PortPicker
                        planId={planId}
                        port={p.a}
                        other={p.b}
                        family={family}
                        includeMgmt={includeMgmt}
                        exclude={usedBy(p.key)}
                        onChange={(port) => setPort(p.key, "a", port)}
                      />
                      <PortPicker
                        planId={planId}
                        port={p.b}
                        other={p.a}
                        family={family}
                        includeMgmt={includeMgmt}
                        exclude={usedBy(p.key)}
                        onChange={(port) => setPort(p.key, "b", port)}
                      />
                    </div>
                  )}
                </li>
              ))}
          </ul>
          {data.short.map((s) => (
            <p
              key={`${s.a_device.id}-${s.b_device.id}`}
              data-part="connect-short"
              className="text-[11px] text-muted-foreground"
            >
              {s.a_device.name} → {s.b_device.name}: {s.reason}
            </p>
          ))}

          <div className="mt-1 grid gap-2">
            {statuses.length ? (
              <FormStatusSelect
                value={status?.id ?? null}
                onChange={setStatusId}
                options={statuses}
              />
            ) : (
              <p
                data-part="no-planned-status"
                className="text-[11px] text-muted-foreground"
              >
                No planned cable status.{" "}
                <Link to="/statuses/new" className="underline">
                  Add one
                </Link>
              </p>
            )}
            <FormCombobox
              label="Type"
              value={type}
              onChange={setType}
              noneLabel="Suggested"
              placeholder="Suggested"
              searchPlaceholder="Search types…"
              emptyText="No types."
              options={choices.cable_types}
            />
            <FormColor label="Color" value={color} onChange={setColor} />
          </div>
          {!data.can_add && (
            <p className="text-[11px] text-muted-foreground">
              You may not add cables.
            </p>
          )}
        </section>
      )}
    </PanelShell>
  )
}
