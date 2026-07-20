import { useEffect, useMemo, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronUp, ChevronDown, Plus, RotateCcw, X } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type CustomField,
  type DeviceRole,
  type FloorTileTypeOption,
  type FloorplanPopoverSettings,
  type Paginated,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { QueryError } from "@/components/query-error"
import { apiErrorToast } from "@/lib/api-toast"
import { cn } from "@/lib/utils"

/** Labels + hints for the server's built-in vocabulary. A key without an entry
 * still renders (falling back to the raw key), so a newly-added server field is
 * never invisible here. Custom fields are labelled from their own definitions. */
const FIELD_META: Record<string, { label: string; hint: string }> = {
  name: { label: "Name", hint: "Label, or the linked object's name" },
  type: { label: "Type", hint: "Tile type or device role" },
  status: { label: "Status", hint: "Planned / reserved / active / …" },
  linked: {
    label: "Linked object",
    hint: "A link to the object it represents",
  },
  position: { label: "Position", hint: "Grid X, Y" },
  size: { label: "Size", hint: "Footprint in cells" },
  orientation: { label: "Orientation", hint: "Rotation in degrees" },
  color: { label: "Colour", hint: "The tile's paint colour" },
  fov: { label: "Coverage", hint: "Camera FOV / PTZ reach" },
  plan: { label: "Plan", hint: "Which floor plan it's on" },
  created: { label: "Created", hint: "When the tile was placed" },
  updated: { label: "Updated", hint: "When the tile last changed" },
  utilization: { label: "Utilization", hint: "Racks: used U + a bar" },
  power: { label: "Power", hint: "Racks: allocated vs maximum watts" },
  weight: { label: "Weight", hint: "Racks: total vs maximum load" },
  device_count: { label: "Device count", hint: "Racks: devices mounted" },
  check: { label: "Monitoring", hint: "Live up / degraded / down" },
  linked_status: {
    label: "Object status",
    hint: "The rack/device's own status",
  },
  linked_role: { label: "Object role", hint: "The rack/device's role" },
  linked_site: { label: "Site", hint: "The object's site" },
  linked_description: {
    label: "Description",
    hint: "The object's description",
  },
  linked_tags: { label: "Tags", hint: "The object's tags" },
  linked_numid: { label: "Object ID", hint: "The human-readable #id" },
  linked_primary_ip: { label: "Primary IP", hint: "Devices only" },
  linked_serial: { label: "Serial", hint: "Devices only" },
  linked_asset_tag: { label: "Asset tag", hint: "Devices only" },
}

/** Groups for the "add a field" picker, so 25+ keys stay navigable. */
const GROUPS: { title: string; keys: string[] }[] = [
  {
    title: "The tile",
    keys: [
      "name",
      "type",
      "status",
      "linked",
      "position",
      "size",
      "orientation",
      "color",
      "fov",
      "plan",
      "created",
      "updated",
    ],
  },
  {
    title: "Live state",
    keys: ["utilization", "power", "weight", "device_count", "check"],
  },
  {
    title: "The linked rack / device",
    keys: [
      "linked_status",
      "linked_role",
      "linked_site",
      "linked_description",
      "linked_tags",
      "linked_numid",
      "linked_primary_ip",
      "linked_serial",
      "linked_asset_tag",
    ],
  },
]

const GLOBAL = "__global__"

export const Route = createFileRoute("/settings/floorplan")({
  component: FloorplanSettingsPage,
})

function FloorplanSettingsPage() {
  const { canManage, canManageDeployment } = useMe()
  const qc = useQueryClient()

  // Which layer is being edited. Tenants genuinely differ, so THIS TENANT is the
  // default; the deployment default is what a tenant inherits when it doesn't
  // override, and only a deployment admin can touch it.
  const [layer, setLayer] = useState<"tenant" | "deployment">("tenant")
  const editingTenant = layer === "tenant"

  const q = useQuery({
    queryKey: editingTenant
      ? ["tenant-floorplan-popover"]
      : ["deployment-floorplan-popover"],
    queryFn: () =>
      api<FloorplanPopoverSettings>(
        editingTenant
          ? "/api/tenant-settings/floorplan-popover/"
          : "/api/deployment/floorplan-popover/"
      ),
    enabled: editingTenant ? canManage : canManageDeployment,
  })
  const tileTypes = useQuery({
    queryKey: ["floor-tile-types-picker"],
    queryFn: () =>
      api<Paginated<FloorTileTypeOption>>("/api/floor-tile-types/?picker=1"),
  })
  const roles = useQuery({
    queryKey: ["device-roles"],
    queryFn: () => api<Paginated<DeviceRole>>("/api/device-roles/"),
  })
  // Custom fields are the tenant's own — never enumerated server-side, so the
  // options come from their definitions and ride the generic cf_<key> convention.
  const deviceCfs = useQuery({
    queryKey: ["custom-fields-for", "device"],
    queryFn: () =>
      api<Paginated<CustomField>>("/api/custom-fields/?model=device"),
  })
  const rackCfs = useQuery({
    queryKey: ["custom-fields-for", "rack"],
    queryFn: () =>
      api<Paginated<CustomField>>("/api/custom-fields/?model=rack"),
  })

  // Local working copy of BOTH layers; saved together.
  const [fields, setFields] = useState<string[] | null>(null)
  const [overrides, setOverrides] = useState<Record<string, string[]> | null>(
    null
  )
  const [override, setOverride] = useState<boolean | null>(null)
  const [scope, setScope] = useState<string>(GLOBAL)
  useEffect(() => {
    if (q.data) {
      setFields(q.data.popover_fields)
      setOverrides(q.data.tile_overrides)
      setOverride(q.data.override ?? null)
    }
  }, [q.data])

  const cfMeta = useMemo(() => {
    const out: Record<string, { label: string; hint: string }> = {}
    for (const [defs, where] of [
      [deviceCfs.data?.results, "device"],
      [rackCfs.data?.results, "rack"],
    ] as const) {
      for (const d of defs ?? []) {
        const key = `cf_${d.key}`
        out[key] = out[key]
          ? { label: d.label, hint: `${out[key].hint} · ${where}` }
          : { label: d.label, hint: `Custom field · ${where}` }
      }
    }
    return out
  }, [deviceCfs.data, rackCfs.data])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<FloorplanPopoverSettings>(
        editingTenant
          ? "/api/tenant-settings/floorplan-popover/"
          : "/api/deployment/floorplan-popover/",
        { method: "PUT", body: JSON.stringify(body) }
      ),
    onSuccess: (data) => {
      setFields(data.popover_fields)
      setOverrides(data.tile_overrides)
      setOverride(data.override ?? null)
      qc.invalidateQueries({
        queryKey: editingTenant
          ? ["tenant-floorplan-popover"]
          : ["deployment-floorplan-popover"],
      })
      // The canvas reads the effective config — refresh so it takes effect
      // without a reload.
      qc.invalidateQueries({ queryKey: ["floorplan-popover"] })
      toast.success("Floor-plan popover updated")
    },
    onError: (e) => apiErrorToast(e),
  })

  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">
        Admin required to change the floor-plan popover.
      </p>
    )
  if (q.isError) return <QueryError error={q.error} />
  if (!q.data || fields === null || overrides === null)
    return <p className="text-sm text-muted-foreground">Loading…</p>

  // When this tenant inherits, the whole editor is a read-only preview of what
  // it's inheriting.
  const inheriting = editingTenant && override === false

  const meta = (key: string) =>
    FIELD_META[key] ?? cfMeta[key] ?? { label: key, hint: "" }

  const allKeys = [...q.data.available, ...Object.keys(cfMeta)]
  const cfKeys = Object.keys(cfMeta)

  // The list being edited: the global one, or the scope's override. While this
  // tenant inherits, nothing is editable — it's a preview.
  const isGlobal = scope === GLOBAL
  const overriding = !inheriting && (isGlobal || scope in overrides)
  const current = isGlobal ? fields : (overrides[scope] ?? fields)

  const setCurrent = (next: string[]) => {
    if (isGlobal) setFields(next)
    else setOverrides({ ...overrides, [scope]: next })
  }
  const startOverride = () =>
    setOverrides({ ...overrides, [scope]: [...fields] })
  const resetToInherit = () => {
    const next = { ...overrides }
    delete next[scope]
    setOverrides(next)
  }

  const toggle = (key: string) =>
    setCurrent(
      current.includes(key)
        ? current.filter((k) => k !== key)
        : // Insert in the vocabulary's canonical order, so ticking a field on
          // doesn't scramble the layout you already arranged.
          allKeys.filter((k) => current.includes(k) || k === key)
    )
  const move = (key: string, delta: number) => {
    const next = [...current]
    const i = next.indexOf(key)
    const j = i + delta
    if (i < 0 || j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j], next[i]]
    setCurrent(next)
  }

  const dirty =
    JSON.stringify(fields) !== JSON.stringify(q.data.popover_fields) ||
    JSON.stringify(overrides) !== JSON.stringify(q.data.tile_overrides) ||
    override !== (q.data.override ?? null)

  const scopeRow = (
    key: string,
    label: string,
    badge: { color?: string; icon?: string } | null,
    custom: boolean
  ) => (
    <button
      key={key}
      type="button"
      onClick={() => setScope(key)}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px]",
        scope === key ? "bg-muted font-medium" : "hover:bg-muted/60"
      )}
    >
      {/* The same badge the palette and the objects sidebar draw, so a type is
          recognisable wherever it appears. */}
      {badge && <TileBadge color={badge.color} icon={badge.icon} />}
      <span className="min-w-0 truncate">{label}</span>
      {custom && (
        <Badge variant="secondary" className="ml-auto h-4 px-1 text-[10px]">
          Custom
        </Badge>
      )}
    </button>
  )

  return (
    <div className="max-w-4xl space-y-6">
      <div className="mb-4">
        <h1 className="text-base font-medium">Floor plans</h1>
        <p className="mt-1 text-xs text-muted-foreground">
          What the tile popover shows when you hover or click a tile on a floor
          plan.
        </p>
      </div>

      {/* Tenants genuinely differ here, so THIS TENANT is the default layer; the
          deployment default is what a tenant inherits when it doesn't override. */}
      {canManageDeployment && (
        <div className="mb-4">
          <SegmentedTabs
            value={layer}
            onValueChange={setLayer}
            items={[
              { value: "tenant", label: "This tenant" },
              { value: "deployment", label: "Deployment default" },
            ]}
          />
        </div>
      )}

      {editingTenant && (
        <div className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-medium">
              {override
                ? "This tenant has its own popover"
                : "Using the deployment default"}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {override
                ? "These fields apply to this tenant only."
                : "Inheriting the deployment-wide fields shown below."}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const next = !override
              setOverride(next)
              // Seed the override from what it was inheriting, so you start from
              // the current look rather than a blank slate.
              if (next && q.data.deployment_defaults) {
                setFields(q.data.deployment_defaults.popover_fields)
                setOverrides(q.data.deployment_defaults.tile_overrides)
              }
            }}
          >
            {override ? "Use deployment default" : "Override for this tenant"}
          </Button>
        </div>
      )}

      <div className="flex gap-4">
        {/* Scopes. A type without its own list inherits the default, so you only
            configure the ones that genuinely differ. */}
        <aside className="w-56 shrink-0">
          <p className="mb-1 px-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
            Applies to
          </p>
          {scopeRow(GLOBAL, "All tiles (default)", null, false)}

          {(tileTypes.data?.results.length ?? 0) > 0 && (
            <p className="mt-3 mb-1 px-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Tile types
            </p>
          )}
          {tileTypes.data?.results.map((t) =>
            scopeRow(
              `tt:${t.slug}`,
              t.name,
              { color: t.color, icon: t.icon },
              `tt:${t.slug}` in overrides
            )
          )}

          {(roles.data?.results.length ?? 0) > 0 && (
            <p className="mt-3 mb-1 px-2 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
              Device roles
            </p>
          )}
          {roles.data?.results.map((r) =>
            // Roles carry no icon — the badge falls back to a colour chip.
            scopeRow(
              `role:${r.slug}`,
              r.name,
              { color: r.color },
              `role:${r.slug}` in overrides
            )
          )}
        </aside>

        <section className="min-w-0 flex-1 rounded-lg border border-border p-4">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">
                {isGlobal
                  ? "All tiles"
                  : scopeLabel(
                      scope,
                      tileTypes.data?.results,
                      roles.data?.results
                    )}
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isGlobal
                  ? "Shown in this order. A field with nothing to say for a tile is skipped automatically."
                  : overriding
                    ? "This type shows its own fields instead of the default."
                    : "Inherits the default. Override only if this type needs different fields."}
              </p>
            </div>
            {!isGlobal &&
              (overriding ? (
                <Button variant="outline" size="sm" onClick={resetToInherit}>
                  <RotateCcw className="h-3.5 w-3.5" /> Inherit
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={startOverride}>
                  Override
                </Button>
              ))}
          </div>

          <ul
            className={cn("flex flex-col gap-1", !overriding && "opacity-60")}
          >
            {current.map((key, i) => (
              <li
                key={key}
                className="flex items-center gap-2 rounded-md border border-border px-2 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate">
                  <span className="text-[13px] font-medium">
                    {meta(key).label}
                  </span>
                  {meta(key).hint && (
                    <span className="ml-2 text-[11px] text-muted-foreground">
                      {meta(key).hint}
                    </span>
                  )}
                </span>
                {overriding && (
                  <span className="flex shrink-0 items-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      disabled={i === 0}
                      onClick={() => move(key, -1)}
                      aria-label={`Move ${meta(key).label} up`}
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      disabled={i === current.length - 1}
                      onClick={() => move(key, 1)}
                      aria-label={`Move ${meta(key).label} down`}
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                      onClick={() => toggle(key)}
                      aria-label={`Remove ${meta(key).label}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </span>
                )}
              </li>
            ))}
            {current.length === 0 && (
              <li className="rounded-md border border-dashed border-border px-2 py-3 text-center text-[13px] text-muted-foreground">
                No fields — the popover shows just the tile's name.
              </li>
            )}
          </ul>

          {overriding && (
            <div className="mt-4 space-y-3">
              {[
                ...GROUPS,
                ...(cfKeys.length
                  ? [{ title: "Custom fields", keys: cfKeys }]
                  : []),
              ].map((g) => {
                const rest = g.keys.filter(
                  (k) => !current.includes(k) && allKeys.includes(k)
                )
                if (!rest.length) return null
                return (
                  <div key={g.title}>
                    <p className="mb-1.5 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
                      {g.title}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {rest.map((key) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => toggle(key)}
                          title={meta(key).hint}
                          className="inline-flex items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-[12px] text-muted-foreground hover:border-solid hover:text-foreground"
                        >
                          <Plus className="h-3 w-3" />
                          {meta(key).label}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>

      <div className="mt-4 flex items-center gap-2">
        <Button
          size="sm"
          disabled={!dirty || save.isPending}
          onClick={() =>
            save.mutate({
              popover_fields: fields,
              tile_overrides: overrides,
              ...(editingTenant ? { override: !!override } : {}),
            })
          }
        >
          Save
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!dirty}
          onClick={() => {
            setFields(q.data.popover_fields)
            setOverrides(q.data.tile_overrides)
          }}
        >
          Reset
        </Button>
        {isGlobal && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => setFields(q.data.defaults)}
          >
            Restore defaults
          </Button>
        )}
      </div>
    </div>
  )
}

function scopeLabel(
  scope: string,
  tileTypes: FloorTileTypeOption[] | undefined,
  roles: DeviceRole[] | undefined
): string {
  const [kind, slug] = scope.split(":")
  const hit =
    kind === "tt"
      ? tileTypes?.find((t) => t.slug === slug)
      : roles?.find((r) => r.slug === slug)
  return hit?.name ?? slug
}
