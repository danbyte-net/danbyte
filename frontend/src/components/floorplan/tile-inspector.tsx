import { useQuery } from "@tanstack/react-query"
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  PanelRight,
  RotateCw,
  Trash2,
  Waypoints,
} from "lucide-react"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  DeviceRole,
  FloorPlanLinkKind,
  FloorPlanRiserOption,
  FloorPlanTile,
  FloorTileStatus,
  FloorTileTypeOption,
  FovAnchor,
  PowerPanelOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorPicker } from "@/components/ui/color-picker"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { BarIconButton, BarTip } from "@/components/map-toolbar"
import { DevicePicker } from "@/components/device-picker"
import { DynamicIcon } from "@/components/dynamic-icon"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormSelect,
} from "@/components/forms"
import { RackPicker } from "@/components/rack-picker"
import { cn } from "@/lib/utils"

import { CabinetLinkField } from "./cabinet-link-field"
import { tileFill, tileHasFov, tileIsZone } from "./floor-canvas"

const STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "planned", label: "Planned" },
  { value: "reserved", label: "Reserved" },
  { value: "decommissioning", label: "Decommissioning" },
]

const LINK_KIND_OPTIONS = [
  { value: "rack", label: "Rack" },
  { value: "cabinet", label: "Cabinet" },
  { value: "device", label: "Device" },
  { value: "powerpanel", label: "Power panel" },
  { value: "powerfeed", label: "Power feed" },
  { value: "coolingsource", label: "Cooling source" },
  { value: "floorplan", label: "Floor plan (nested)" },
]

/** A labelled FOV slider with a live value readout.
 *
 * The value sits beside the label rather than in a box: you're dragging against
 * the cone drawn on the plan, so the number is feedback, not an input. */
function FovSlider({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  unit: string
  onChange: (value: number) => void
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">{label}</span>
        <span className="num text-[12px] font-medium">
          {value}
          {unit}
        </span>
      </div>
      <Slider
        className="mt-1.5"
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={([v]) => onChange(v)}
        aria-label={label}
      />
    </div>
  )
}

/** Editor inspector - label / color / status / rotate / link / delete. */
export function TileInspector({
  tile,
  planId,
  siteId,
  cellMm,
  tileTypes,
  roles,
  onChange,
  onRotate,
  onSetFacing,
  onFit,
  onDelete,
  onOpenContents,
}: {
  tile: FloorPlanTile
  planId: string
  /** The plan's site and cell size - a cabinet link reads both. */
  siteId: string
  cellMm: number
  tileTypes: FloorTileTypeOption[]
  roles: DeviceRole[]
  onChange: (patch: Partial<FloorPlanTile>) => void
  onRotate: () => void
  onSetFacing: (o: 0 | 90 | 180 | 270) => void
  /** Size the tile to what it links to, in cells. */
  onFit: (size: { width: number; height: number }) => void
  onDelete: () => void
  onOpenContents?: () => void
}) {
  const linkKind = tile.linked?.kind ?? null
  const setLink = (kind: FloorPlanLinkKind | null, id: string | null) => {
    if (!kind || !id) {
      onChange({ link_kind: "", linked: null })
      return
    }
    onChange({
      link_kind: kind,
      linked: {
        kind,
        id,
        name: tile.linked?.id === id ? tile.linked.name : "",
        route: "",
      },
    })
  }
  // A just-picked object's name, once known: the tile's label falls back to
  // it before the plan is saved, as it does after.
  const setLinkedName = (name: string) => {
    if (tile.linked) onChange({ linked: { ...tile.linked, name } })
  }

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
          Tile
        </span>
        <span className="num text-[11px] text-muted-foreground">
          ({tile.x},{tile.y}) · {tile.width}×{tile.height}
        </span>
      </div>

      <div className="flex items-center gap-2 text-sm">
        <span
          className="inline-flex h-6 w-6 items-center justify-center rounded"
          style={{
            backgroundColor: `${tileFill(tile)}33`,
            color: tileFill(tile),
          }}
        >
          {tile.tile_type?.icon ? (
            <DynamicIcon name={tile.tile_type.icon} className="h-3.5 w-3.5" />
          ) : (
            <span
              className="h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: tileFill(tile) }}
            />
          )}
        </span>
        <span className="font-medium">
          {tile.tile_type?.name ?? tile.role_type?.name}
        </span>
        <BarIconButton
          label="Rotate 90°"
          className="ml-auto"
          onClick={onRotate}
        >
          <RotateCw className="size-3.5" />
        </BarIconButton>
      </div>

      {/* Re-type a placed tile: any tile type (zones stay zones), or a device
        role standing in as a type. Links and geometry are untouched. */}
      <FormCombobox
        label="Type"
        value={
          tile.tile_type
            ? `tt:${tile.tile_type.id}`
            : tile.role_type
              ? `role:${tile.role_type.id}`
              : null
        }
        onChange={(v) => {
          if (!v) return
          const [kind, id] = v.split(":")
          if (kind === "tt") {
            const tt = tileTypes.find((t) => t.id === id)
            if (tt) onChange({ tile_type: tt, role_type: null })
          } else {
            const r = roles.find((x) => x.id === id)
            if (r)
              onChange({
                tile_type: null,
                role_type: {
                  id: r.id,
                  name: r.name,
                  slug: r.slug,
                  color: r.color,
                  is_patch_panel: r.is_patch_panel,
                  has_fov: r.has_fov,
                },
              })
          }
        }}
        options={[
          ...tileTypes
            .filter((tt) => tt.is_zone === !!tile.tile_type?.is_zone)
            .map((tt) => ({ value: `tt:${tt.id}`, label: tt.name })),
          ...(tile.tile_type?.is_zone
            ? []
            : roles.map((r) => ({
                value: `role:${r.id}`,
                label: `${r.name} (role)`,
              }))),
        ]}
        searchPlaceholder="Search types…"
        emptyText="No types."
      />
      {/* Facing is the TILE's own property - build-in-advance tiles need it
          set before any rack is linked, so only zones (no front) skip it. */}
      {!tileIsZone(tile) && (
        <Field label="Front faces" hint="Marked on the tile's front edge">
          <div className="grid grid-cols-4 gap-1">
            {(
              [
                { o: 0 as const, icon: ArrowUp, label: "Up" },
                { o: 90 as const, icon: ArrowRight, label: "Right" },
                { o: 180 as const, icon: ArrowDown, label: "Down" },
                { o: 270 as const, icon: ArrowLeft, label: "Left" },
              ] as const
            ).map(({ o, icon: Icon, label }) => (
              <BarTip key={o} tip={`Front faces ${label.toLowerCase()}`}>
                <Button
                  variant={tile.orientation === o ? "secondary" : "outline"}
                  size="sm"
                  className={cn(
                    "h-8 px-0",
                    tile.orientation === o && "border-primary/50"
                  )}
                  onClick={() => onSetFacing(o)}
                  aria-label={`Front faces ${label.toLowerCase()}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                </Button>
              </BarTip>
            ))}
          </div>
        </Field>
      )}

      <Field label="Label" hint="Overrides the linked object's name">
        <Input
          value={tile.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder={tile.linked?.name || "Optional"}
          className="h-8 text-sm"
        />
      </Field>

      <Field label="Color" hint="Overrides the type color">
        <ColorPicker
          value={tile.color}
          onChange={(color) => onChange({ color })}
        />
      </Field>

      <FormSelect
        label="Status"
        value={tile.status || null}
        onChange={(v) => onChange({ status: (v ?? "") as FloorTileStatus })}
        options={STATUS_OPTIONS}
        noneLabel="-"
        placeholder="-"
      />

      {tileHasFov(tile) && (
        <div className="grid gap-2">
          <span className="text-[11px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            Field of view
          </span>
          <FormCheckbox
            label={
              <>
                PTZ <span className="text-muted-foreground">- 360° ring</span>
              </>
            }
            checked={tile.fov_ptz}
            onChange={(v) => onChange({ fov_ptz: v })}
            className="items-center text-[13px]"
          />
          {/* Sliders, not number boxes: these are all continuous physical
              quantities you tune against the cone drawn on the plan, so dragging
              with live feedback beats typing a number and re-reading the canvas. */}
          <div className="grid gap-3">
            {!tile.fov_ptz && (
              <FovSlider
                label="Direction"
                value={tile.fov_direction ?? 0}
                min={0}
                max={359}
                unit="°"
                onChange={(v) => onChange({ fov_direction: v })}
              />
            )}
            {!tile.fov_ptz && (
              <FovSlider
                label="Angle"
                value={tile.fov_deg ?? 90}
                min={10}
                max={360}
                step={5}
                unit="°"
                onChange={(v) => onChange({ fov_deg: v })}
              />
            )}
            <FovSlider
              label="Reach"
              value={tile.fov_distance ?? 3}
              min={1}
              max={50}
              unit=" cells"
              onChange={(v) => onChange({ fov_distance: v })}
            />
          </div>
          <Field label="Emits from" hint="Click a dot">
            <FovAnchorDice
              value={tile.fov_anchor}
              onChange={(a) => onChange({ fov_anchor: a })}
            />
          </Field>
        </div>
      )}

      <div className="grid gap-2">
        <FormSelect
          label="Linked object"
          hint="Drives overlays + deep links"
          value={linkKind}
          onChange={(v) => {
            if (!v) setLink(null, null)
            else if (v !== linkKind)
              onChange({
                link_kind: v as FloorPlanLinkKind,
                linked: null,
              })
          }}
          options={LINK_KIND_OPTIONS}
          noneLabel="Not linked"
          placeholder="Not linked"
        />
        {tile.linked?.hidden ? (
          // Another site's object: nothing to show or pick from here; the
          // kind above relinks or unlinks the tile.
          <p className="text-sm text-muted-foreground">Hidden</p>
        ) : tile.link_kind === "cabinet" ? (
          <CabinetLinkField
            tile={tile}
            siteId={siteId}
            cellMm={cellMm}
            onPick={(id) => setLink("cabinet", id)}
            onName={setLinkedName}
            onFit={onFit}
          />
        ) : (
          <LinkTargetPicker
            kind={tile.link_kind || null}
            value={tile.linked?.id ?? null}
            planId={planId}
            roleId={tile.role_type?.id ?? null}
            onPick={(id) => setLink(tile.link_kind || null, id)}
          />
        )}
      </div>

      <RiserFields tile={tile} planId={planId} onChange={onChange} />

      <div className="mt-auto grid gap-2 border-t border-border pt-3">
        {onOpenContents && (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onOpenContents}
          >
            {tile.linked?.kind === "device" ? (
              <Waypoints className="h-3.5 w-3.5" />
            ) : (
              <PanelRight className="h-3.5 w-3.5" />
            )}
            {tile.linked?.kind === "device" ? "Trace" : "Contents & trace"}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDelete}
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove tile
        </Button>
      </div>
    </aside>
  )
}

/** A riser: cables leave this floor through it, to the riser it pairs
 * with on another floor of the site. */
function RiserFields({
  tile,
  planId,
  onChange,
}: {
  tile: FloorPlanTile
  planId: string
  onChange: (patch: Partial<FloorPlanTile>) => void
}) {
  const options = useQuery({
    queryKey: ["floor-plan-risers", planId],
    queryFn: () =>
      api<{ risers: FloorPlanRiserOption[] }>(
        `/api/floor-plans/${planId}/risers/`
      ),
    enabled: !!tile.riser,
    staleTime: 30_000,
  })
  const pair = tile.riser_pair ?? null
  const free = (options.data?.risers ?? []).filter(
    (r) => !r.pair || r.pair === tile.id || r.id === pair?.id
  )
  return (
    <div className="grid gap-2" data-part="riser">
      <FormCheckbox
        label="Riser"
        checked={!!tile.riser}
        onChange={(v) =>
          onChange(
            v
              ? { riser: true }
              : { riser: false, riser_pair: null, riser_height_mm: null }
          )
        }
        className="items-center text-[13px]"
      />
      {tile.riser &&
        (pair?.hidden ? (
          <Field label="Pairs with">
            <p className="text-sm text-muted-foreground">Hidden</p>
          </Field>
        ) : (
          <FormCombobox
            label="Pairs with"
            value={pair?.id ?? null}
            onChange={(id) => {
              const r = free.find((x) => x.id === id)
              onChange({
                riser_pair: r
                  ? {
                      id: r.id,
                      label: r.label,
                      floor_plan: {
                        id: r.floor_plan.id,
                        name: r.floor_plan.name,
                      },
                    }
                  : null,
              })
            }}
            options={free.map((r) => ({
              value: r.id,
              label: `${r.label} · ${r.floor_plan.name}`,
              group: r.floor_plan.stack || undefined,
            }))}
            noneLabel="Not paired"
            placeholder="Not paired"
            searchPlaceholder="Search risers…"
            emptyText="No risers on other floors."
          />
        ))}
      {tile.riser && (
        <Field label="Height (mm)" hint="Blank: from the floors">
          <Input
            type="number"
            min={0}
            value={tile.riser_height_mm ?? ""}
            onChange={(e) => {
              const v = e.target.value
              onChange({
                riser_height_mm:
                  v === "" ? null : Math.max(0, Math.round(Number(v))),
              })
            }}
            className="h-8 text-sm"
          />
        </Field>
      )}
    </div>
  )
}

function LinkTargetPicker({
  kind,
  value,
  planId,
  roleId,
  onPick,
}: {
  kind: FloorPlanLinkKind | null
  value: string | null
  planId: string
  /** The tile's device role (role tiles) - devices with it sort first in the
   * picker, and the advanced dialog opens pre-filtered to it. */
  roleId?: string | null
  onPick: (id: string | null) => void
}) {
  const panels = useQuery({
    queryKey: ["power-panels-picker"],
    queryFn: () => apiAll<PowerPanelOption>("/api/power-panels/?picker=1"),
    enabled: kind === "powerpanel",
  })
  const feeds = useQuery({
    queryKey: ["power-feeds-picker"],
    queryFn: () =>
      apiAll<{ id: string; name: string; power_panel: PowerPanelOption }>(
        "/api/power-feeds/"
      ),
    enabled: kind === "powerfeed",
  })
  const sources = useQuery({
    queryKey: ["cooling-sources-picker"],
    queryFn: () =>
      apiAll<{ id: string; name: string }>("/api/cooling-sources/?picker=1"),
    enabled: kind === "coolingsource",
  })
  const plans = useQuery({
    queryKey: ["floor-plans-picker"],
    queryFn: () =>
      apiAll<{ id: string; name: string; stack_name: string | null }>(
        "/api/floor-plans/?picker=1"
      ),
    enabled: kind === "floorplan",
  })

  if (!kind) return null
  if (kind === "rack")
    return <RackPicker label="Rack" value={value} onChange={onPick} />
  if (kind === "device")
    return (
      <DevicePicker
        label="Device"
        value={value}
        onChange={onPick}
        preferQuery={roleId ? `role=${roleId}` : undefined}
        initialFilters={roleId ? { role: roleId } : undefined}
      />
    )
  if (kind === "powerpanel")
    return (
      <FormCombobox
        label="Power panel"
        value={value}
        onChange={onPick}
        options={(panels.data?.results ?? []).map((p) => ({
          value: p.id,
          label: p.name,
        }))}
        placeholder="Select a panel…"
        searchPlaceholder="Search panels…"
        emptyText="No power panels."
      />
    )
  if (kind === "powerfeed")
    return (
      <FormCombobox
        label="Power feed"
        value={value}
        onChange={onPick}
        options={(feeds.data?.results ?? []).map((f) => ({
          value: f.id,
          label: `${f.name} (${f.power_panel.name})`,
        }))}
        placeholder="Select a feed…"
        searchPlaceholder="Search feeds…"
        emptyText="No power feeds."
      />
    )
  if (kind === "coolingsource")
    return (
      <FormCombobox
        label="Cooling source"
        value={value}
        onChange={onPick}
        options={(sources.data?.results ?? []).map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        placeholder="Select a source…"
        searchPlaceholder="Search sources…"
        emptyText="No cooling sources."
      />
    )
  return (
    <FormCombobox
      label="Floor plan"
      value={value}
      onChange={onPick}
      options={(plans.data?.results ?? [])
        .filter((p) => p.id !== planId)
        .map((p) => ({
          value: p.id,
          label:
            p.stack_name && p.stack_name !== p.name
              ? `${p.stack_name} · ${p.name}`
              : p.name,
        }))}
      placeholder="Select a plan…"
      searchPlaceholder="Search plans…"
      emptyText="No other floor plans."
    />
  )
}

/** Dice-5 anchor picker: five dots (corners + center) - click where the
 * FOV cone should emit from on the tile. */
function FovAnchorDice({
  value,
  onChange,
}: {
  value: FovAnchor
  onChange: (a: FovAnchor) => void
}) {
  const dots: { a: FovAnchor; cx: number; cy: number; label: string }[] = [
    { a: "tl", cx: 12, cy: 12, label: "Top left" },
    { a: "tr", cx: 44, cy: 12, label: "Top right" },
    { a: "", cx: 28, cy: 28, label: "Center" },
    { a: "bl", cx: 12, cy: 44, label: "Bottom left" },
    { a: "br", cx: 44, cy: 44, label: "Bottom right" },
  ]
  return (
    <svg
      width={56}
      height={56}
      className="rounded-md border border-border bg-muted/30"
      role="radiogroup"
      aria-label="Cone anchor"
    >
      {dots.map((d) => (
        <circle
          key={d.a || "center"}
          cx={d.cx}
          cy={d.cy}
          r={value === d.a ? 6 : 4}
          className={cn(
            "cursor-pointer transition-[r,fill]",
            value === d.a
              ? "fill-foreground"
              : "fill-muted-foreground/35 hover:fill-muted-foreground"
          )}
          role="radio"
          aria-checked={value === d.a}
          aria-label={d.label}
          onClick={() => onChange(d.a)}
        >
          <title>{d.label}</title>
        </circle>
      ))}
    </svg>
  )
}
