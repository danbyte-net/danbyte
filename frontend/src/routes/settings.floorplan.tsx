import { useEffect, useState } from "react"
import { createFileRoute } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DeviceRole,
  FloorTileTypeOption,
  FloorplanPopoverSettings,
  Paginated,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { TileBadge } from "@/components/floorplan/tile-badge"
import { QueryError } from "@/components/query-error"
import {
  FieldListEditor,
  FieldScopeHeading,
  FieldScopeRow,
  useCustomFieldMeta,
} from "@/components/settings/field-list-editor"
import type { FieldMeta } from "@/components/settings/field-list-editor"
import {
  SettingsCard,
  SettingsHeader,
} from "@/components/settings/settings-card"
import { apiErrorToast } from "@/lib/api-toast"

/** Labels + hints for the server's built-in vocabulary. A key without an entry
 * still renders (falling back to the raw key), so a newly-added server field is
 * never invisible here. Custom fields are labelled from their own definitions. */
const FIELD_META: Partial<Record<string, FieldMeta>> = {
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
  color: { label: "Color", hint: "The tile's paint color" },
  fov: { label: "Coverage", hint: "Camera FOV / PTZ reach" },
  plan: { label: "Plan", hint: "Which floor plan it's on" },
  created: { label: "Created", hint: "When the tile was placed" },
  updated: { label: "Updated", hint: "When the tile last changed" },
  utilization: {
    label: "Utilization",
    hint: "Racks: used U + a bar · cabinets: devices, rails",
  },
  power: { label: "Power", hint: "Racks: allocated vs maximum watts" },
  weight: { label: "Weight", hint: "Racks: total vs maximum load" },
  device_count: {
    label: "Device count",
    hint: "Racks and cabinets: devices in it",
  },
  rail_count: { label: "Rails", hint: "Cabinets: DIN rails on the plate" },
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
  faceplate: {
    label: "Faceplate",
    hint: "Devices only - the front/rear panel",
  },
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
    keys: [
      "utilization",
      "power",
      "weight",
      "device_count",
      "rail_count",
      "check",
    ],
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
      "faceplate",
    ],
  },
]

const GLOBAL = "__global__"

const CF_MODELS = ["device", "rack", "cabinet"] as const

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
  // Custom fields are the tenant's own - never enumerated server-side, so the
  // options come from their definitions and ride the generic cf_<key> convention.
  const cfMeta = useCustomFieldMeta(CF_MODELS)

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
      // The canvas reads the effective config - refresh so it takes effect
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

  const meta = (key: string): FieldMeta =>
    FIELD_META[key] ?? cfMeta[key] ?? { label: key, hint: "" }

  const allKeys = [...q.data.available, ...Object.keys(cfMeta)]
  const cfKeys = Object.keys(cfMeta)

  // The list being edited: the global one, or the scope's override. While this
  // tenant inherits, nothing is editable - it's a preview.
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
    <FieldScopeRow
      key={key}
      active={scope === key}
      onSelect={() => setScope(key)}
      // The same badge the palette and the objects sidebar draw, so a type is
      // recognisable wherever it appears.
      badge={badge && <TileBadge color={badge.color} icon={badge.icon} />}
      label={label}
      custom={custom}
    />
  )

  return (
    <div className="space-y-6">
      <SettingsHeader title="Floor plans">
        What the tile popover shows when you hover or click a tile on a floor
        plan.
      </SettingsHeader>

      {/* Tenants genuinely differ here, so THIS TENANT is the default layer; the
          deployment default is what a tenant inherits when it doesn't override. */}
      {canManageDeployment && (
        <SegmentedTabs
          value={layer}
          onValueChange={setLayer}
          items={[
            { value: "tenant", label: "This tenant" },
            { value: "deployment", label: "Deployment default" },
          ]}
        />
      )}

      <SettingsCard
        title="Tile popover"
        description="The fields, and their order, for every tile or for one type."
        layout="flush"
        inherit={
          editingTenant
            ? {
                overridden: !!override,
                onChange: (next) => {
                  setOverride(next)
                  // Seed the override from what it was inheriting, so you start
                  // from the current look rather than a blank slate.
                  if (next && q.data.deployment_defaults) {
                    setFields(q.data.deployment_defaults.popover_fields)
                    setOverrides(q.data.deployment_defaults.tile_overrides)
                  }
                },
                labels: { on: "This tenant", off: "Deployment default" },
                summary: inheritedSummary(q.data.deployment_defaults, meta),
              }
            : undefined
        }
        onSave={() =>
          save.mutate({
            popover_fields: fields,
            tile_overrides: overrides,
            ...(editingTenant ? { override: !!override } : {}),
          })
        }
        dirty={dirty}
        saving={save.isPending}
        saveLabel="Save popover"
        footer={
          <>
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
                onClick={() => setFields(q.data.defaults)}
              >
                Restore defaults
              </Button>
            )}
          </>
        }
      >
        <div className="flex">
          {/* Scopes. A type without its own list inherits the default, so you
              only configure the ones that genuinely differ. */}
          <aside className="w-56 shrink-0 border-r border-border p-3">
            <FieldScopeHeading first>Applies to</FieldScopeHeading>
            {scopeRow(GLOBAL, "All tiles (default)", null, false)}

            {(tileTypes.data?.results.length ?? 0) > 0 && (
              <FieldScopeHeading>Tile types</FieldScopeHeading>
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
              <FieldScopeHeading>Device roles</FieldScopeHeading>
            )}
            {roles.data?.results.map((r) =>
              // Roles carry no icon - the badge falls back to a colour chip.
              scopeRow(
                `role:${r.slug}`,
                r.name,
                { color: r.color },
                `role:${r.slug}` in overrides
              )
            )}
          </aside>

          <div className="min-w-0 flex-1 p-4">
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

            <FieldListEditor
              value={current}
              onChange={setCurrent}
              editable={overriding}
              meta={meta}
              groups={[
                ...GROUPS,
                ...(cfKeys.length
                  ? [{ title: "Custom fields", keys: cfKeys }]
                  : []),
              ]}
              available={allKeys}
              // Insert in the vocabulary's canonical order, so ticking a field
              // on doesn't scramble the layout you already arranged.
              insert="canonical"
              empty="No fields - the popover shows just the tile's name."
            />
          </div>
        </div>
      </SettingsCard>
    </div>
  )
}

/** What a tenant gets while it inherits: the deployment fields, in order. */
function inheritedSummary(
  defaults: FloorplanPopoverSettings["deployment_defaults"],
  meta: (key: string) => { label: string }
) {
  if (!defaults) return <span>Inheriting the deployment default.</span>
  const labels = defaults.popover_fields.map((k) => meta(k).label)
  const types = Object.keys(defaults.tile_overrides).length
  return (
    <span>
      {labels.length ? labels.join(" · ") : "Just the tile name"}
      {types > 0 && ` · ${types} type ${types === 1 ? "override" : "overrides"}`}
    </span>
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
