import { useEffect, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import {
  api,
  type CheckStatus,
  type CustomField,
  type Device,
  type FloorPlanLiveState,
  type FloorPlanTile,
  type FloorTileRackState,
  type Rack,
} from "@/lib/api"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { Badge } from "@/components/ui/badge"
import { StatusBadge } from "@/components/status-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import {
  formatCustomValue,
  useCustomFieldDefs,
} from "@/components/custom-field-display"
import { tileName, utilizationColor } from "@/components/floorplan/floor-canvas"

type LiveTile = FloorPlanLiveState["tiles"][string]

/** The linked object, once fetched. Rack and Device share enough shape
 * (role/status/description/tags/custom_fields) that the linked_* fields work for
 * both; the ones only one of them has simply render null on the other. */
export type LinkedDetail = Partial<Rack> & Partial<Device>

/** Which link kinds carry enough detail to be worth fetching. */
const DETAIL_ENDPOINT: Record<string, string> = {
  rack: "/api/racks",
  device: "/api/devices",
}

/** Which custom-field model a link kind maps to, for formatting cf_* values. */
const CF_MODEL: Record<string, string> = { rack: "rack", device: "device" }

/** Tile status → semantic badge tone. A tile's status is a plain string union
 * (not a Status object), so it can't use StatusBadge. */
const STATUS_TONE: Record<
  string,
  "success" | "warning" | "secondary" | "destructive"
> = {
  active: "success",
  planned: "warning",
  reserved: "warning",
  decommissioning: "destructive",
}

/** Everything a field renderer is allowed to read. */
export interface PopoverCtx {
  tile: FloorPlanTile
  live?: LiveTile
  /** The linked rack/device, if fetched. Undefined while loading or when no
   * configured field needs it. */
  linked?: LinkedDetail | null
  /** Custom-field definitions for the linked object's model, for formatting. */
  cfDefs?: CustomField[]
}

export interface PopoverField {
  /** Row label. */
  label: string
  /** Return null to omit the row entirely (the field has nothing to say). */
  render: (ctx: PopoverCtx) => React.ReactNode | null
  /** Needs the linked object fetched. */
  needsLinked?: boolean
}

const rack = (live?: LiveTile): FloorTileRackState | null =>
  live?.kind === "rack" ? live : null

/**
 * The popover's field vocabulary — a **registry**, not a switch.
 *
 * Adding a field is one entry here; nothing else changes. (Our netbox-map plugin
 * assembles popover content in a big `switch`, so every new field is a code edit
 * in two places — this is the fix for that.)
 *
 * Every field below resolves from the tile + the already-polled live state, so
 * the popover never fetches. Fields that WOULD need a fetch (primary IP, MAC,
 * cable trace) are deliberately absent for now; they slot in later as entries
 * that lazily load and re-render.
 */
export const POPOVER_FIELDS: Record<string, PopoverField> = {
  name: {
    label: "Name",
    render: ({ tile }) => tileName(tile) || null,
  },
  type: {
    label: "Type",
    render: ({ tile }) => tile.tile_type?.name ?? tile.role_type?.name ?? null,
  },
  status: {
    label: "Status",
    render: ({ tile }) =>
      tile.status ? (
        <Badge variant={STATUS_TONE[tile.status] ?? "secondary"}>
          {tile.status}
        </Badge>
      ) : null,
  },
  position: {
    label: "Position",
    render: ({ tile }) => (
      <span className="num">
        {tile.x}, {tile.y}
      </span>
    ),
  },
  size: {
    label: "Size",
    render: ({ tile }) => (
      <span className="num">
        {tile.width}×{tile.height}
      </span>
    ),
  },
  orientation: {
    label: "Orientation",
    render: ({ tile }) =>
      tile.orientation ? (
        <span className="num">{tile.orientation}°</span>
      ) : null,
  },
  utilization: {
    label: "Utilization",
    render: ({ live }) => {
      const r = rack(live)
      if (!r || r.u_height <= 0) return null
      const ratio = r.used_units / r.u_height
      return (
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
            <span
              className="block h-full rounded-full"
              style={{
                width: `${Math.min(100, ratio * 100)}%`,
                background: utilizationColor(ratio),
              }}
            />
          </span>
          <span className="num text-[11px]">
            {r.used_units}/{r.u_height}U · {Math.round(ratio * 100)}%
          </span>
        </span>
      )
    },
  },
  power: {
    label: "Power",
    render: ({ live }) => {
      const r = rack(live)
      if (!r || !r.power?.maximum_w) return null
      return (
        <span className="num text-[11px]">
          {r.power.allocated_w}/{r.power.maximum_w} W
        </span>
      )
    },
  },
  weight: {
    label: "Weight",
    render: ({ live }) => {
      const r = rack(live)
      if (!r || !r.total_weight_kg) return null
      return (
        <span className="num text-[11px]">
          {r.total_weight_kg}
          {r.max_weight_kg ? ` / ${r.max_weight_kg}` : ""} kg
        </span>
      )
    },
  },
  device_count: {
    label: "Devices",
    render: ({ live }) => {
      const r = rack(live)
      return r ? <span className="num">{r.device_count}</span> : null
    },
  },
  check: {
    label: "Monitoring",
    render: ({ live }) => {
      const c = live?.check
      if (!c) return null
      // The real monitoring status pill (same palette as everywhere else),
      // not a bare dot — matches the "Object status" badge above it.
      return <CheckStatusBadge status={c as CheckStatus} />
    },
  },
  color: {
    label: "Colour",
    render: ({ tile }) => {
      const c = tile.color
      if (!c) return null
      return (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-[3px] border border-border"
            style={{ background: c }}
          />
          <span className="font-mono text-[11px]">{c}</span>
        </span>
      )
    },
  },
  fov: {
    label: "Coverage",
    render: ({ tile }) => {
      if (!tile.fov_distance) return null
      if (tile.fov_ptz)
        return (
          <span className="num text-[11px]">
            PTZ · {tile.fov_distance} cells
          </span>
        )
      return (
        <span className="num text-[11px]">
          {tile.fov_deg ?? 0}° · {tile.fov_distance} cells
          {tile.fov_direction != null ? ` @ ${tile.fov_direction}°` : ""}
        </span>
      )
    },
  },
  plan: {
    label: "Plan",
    render: ({ tile }) => tile.floor_plan?.name ?? null,
  },
  created: {
    label: "Created",
    render: ({ tile }) =>
      tile.created_at ? (
        <span className="num text-[11px]">
          {new Date(tile.created_at).toLocaleString()}
        </span>
      ) : null,
  },
  updated: {
    label: "Updated",
    render: ({ tile }) =>
      tile.updated_at ? (
        <span className="num text-[11px]">
          {new Date(tile.updated_at).toLocaleString()}
        </span>
      ) : null,
  },

  // ── The linked rack/device. These trigger the lazy fetch; each renders null
  //    on an object that doesn't carry the field (a rack has no primary IP), so
  //    turning one on is safe across mixed tile types. ──
  linked_status: {
    label: "Object status",
    needsLinked: true,
    render: ({ linked }) =>
      linked?.status ? <StatusBadge status={linked.status} /> : null,
  },
  linked_role: {
    label: "Object role",
    needsLinked: true,
    render: ({ linked }) =>
      linked?.role ? (
        <ColorBadge name={linked.role.name} color={linked.role.color} />
      ) : null,
  },
  linked_site: {
    label: "Site",
    needsLinked: true,
    render: ({ linked }) => linked?.site?.name ?? null,
  },
  linked_description: {
    label: "Description",
    needsLinked: true,
    render: ({ linked }) => linked?.description || null,
  },
  linked_tags: {
    label: "Tags",
    needsLinked: true,
    render: ({ linked }) =>
      linked?.tags?.length ? <TagList tags={linked.tags} /> : null,
  },
  linked_numid: {
    label: "ID",
    needsLinked: true,
    render: ({ linked }) =>
      linked?.numid != null ? (
        <span className="num">#{linked.numid}</span>
      ) : null,
  },
  linked_primary_ip: {
    label: "Primary IP",
    needsLinked: true,
    render: ({ linked }) =>
      linked?.primary_ip ? (
        <span className="font-mono text-[11px]">
          {linked.primary_ip.ip_address}
        </span>
      ) : null,
  },
  linked_serial: {
    label: "Serial",
    needsLinked: true,
    render: ({ linked }) =>
      linked?.serial_number ? (
        <span className="font-mono text-[11px]">{linked.serial_number}</span>
      ) : null,
  },
  linked_asset_tag: {
    label: "Asset tag",
    needsLinked: true,
    render: ({ linked }) =>
      linked?.asset_tag ? (
        <span className="font-mono text-[11px]">{linked.asset_tag}</span>
      ) : null,
  },
}

/** Custom fields ride a generic `cf_<key>` convention — never enumerated, since
 * the tenant defines them (zero pre-filled data). Resolved against the linked
 * object's values + its field definitions, so the value formats the same way it
 * does on the object's own detail page. */
const CF_PREFIX = "cf_"

function cfField(key: string): PopoverField {
  const cfKey = key.slice(CF_PREFIX.length)
  return {
    label: cfKey,
    needsLinked: true,
    render: ({ linked, cfDefs }) => {
      const values = linked?.custom_fields
      if (!values || !(cfKey in values)) return null
      const def = cfDefs?.find((d) => d.key === cfKey)
      const v = values[cfKey]
      if (v === null || v === undefined || v === "") return null
      return formatCustomValue(def, v)
    },
  }
}

/** Resolve a configured key to its field, including dynamic `cf_*` ones. */
export function resolvePopoverField(key: string): PopoverField | null {
  if (key.startsWith(CF_PREFIX)) return cfField(key)
  return POPOVER_FIELDS[key] ?? null
}

/** Default field order + set when nothing is configured. */
export const DEFAULT_POPOVER_FIELDS = [
  "name",
  "type",
  "status",
  "linked",
  "utilization",
  "position",
  "size",
]

export interface HoverTarget {
  tile: FloorPlanTile
  x: number
  y: number
  /** Pinned by a click — survives pointer-leave, dismissed by Esc/outside. */
  pinned: boolean
}

/**
 * Lazily fetch the tile's linked rack/device — only when a configured field
 * actually needs it, and only for kinds that carry detail.
 *
 * Deliberately lazy: the vast majority of popovers show tile-intrinsic fields
 * and must stay fetch-free. React Query caches per object, so hovering the same
 * rack twice costs one request, and the popover re-renders when it lands.
 */
function useLinkedDetail(tile: FloorPlanTile | undefined, needed: boolean) {
  const linked = tile?.linked
  const base = linked ? DETAIL_ENDPOINT[linked.kind] : undefined
  const enabled = !!(needed && base && linked)
  const detail = useQuery({
    queryKey: ["floorplan-linked", linked?.kind, linked?.id],
    queryFn: () => api<LinkedDetail>(`${base}/${linked!.id}/`),
    enabled,
    staleTime: 60_000,
  })
  const model = linked ? CF_MODEL[linked.kind] : undefined
  const defs = useCustomFieldDefs(model ?? "")
  return {
    linked: enabled ? (detail.data ?? null) : undefined,
    cfDefs: model ? defs.data?.results : undefined,
    loading: enabled && detail.isLoading,
  }
}

/**
 * The tile popover — replaces the SVG `<title>` the browser used to render.
 *
 * Anchored to a zero-size div at the hovered point (the canvas reports
 * screen-space coords), so Radix handles collision-flipping, Esc and
 * outside-click for us. Hover previews after a short delay; a click pins it so
 * the content can actually be read and its links clicked — the thing a native
 * tooltip (and netbox-map's hover-only popover) can never do.
 */
export function TilePopover({
  target,
  live,
  fields,
  onOpenChange,
  renderLinked,
  renderActions,
}: {
  target: HoverTarget | null
  live?: LiveTile
  /** Ordered field keys to show. Unknown keys are ignored. */
  fields: string[]
  onOpenChange: (open: boolean) => void
  /** The linked-object link, injected so this component stays route-agnostic. */
  renderLinked?: (tile: FloorPlanTile) => React.ReactNode
  /** Actions (e.g. "Contents & trace") — rendered only when PINNED, since an
   * unpinned preview is pointer-transparent and can't be clicked. */
  renderActions?: (tile: FloorPlanTile) => React.ReactNode
}) {
  const open = !!target

  // Resolve once so we know whether anything needs the linked object BEFORE
  // fetching it — a popover of tile-intrinsic fields must stay fetch-free.
  const resolved = fields
    .filter((k) => k !== "linked")
    .map((key) => ({ key, field: resolvePopoverField(key) }))
    .filter((r): r is { key: string; field: PopoverField } => !!r.field)
  const needsLinked = resolved.some((r) => r.field.needsLinked)
  const { linked, cfDefs, loading } = useLinkedDetail(target?.tile, needsLinked)

  const ctx: PopoverCtx | null = target
    ? { tile: target.tile, live, linked, cfDefs }
    : null

  // Build the rows in configured order, dropping any field with nothing to say
  // and any key the registry doesn't know (stale config must never crash).
  const rows: { key: string; label: string; node: React.ReactNode }[] = []
  if (ctx) {
    for (const key of fields) {
      if (key === "linked") {
        const node = renderLinked?.(ctx.tile)
        if (node) rows.push({ key, label: "Linked", node })
        continue
      }
      const field = resolvePopoverField(key)
      if (!field) continue
      const node = field.render(ctx)
      if (node === null || node === undefined || node === "") continue
      rows.push({ key, label: field.label, node })
    }
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>
        <div
          className="pointer-events-none absolute"
          style={{ left: target?.x ?? 0, top: target?.y ?? 0 }}
        />
      </PopoverAnchor>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={12}
        className="w-64 p-3"
        // Unpinned it's a preview: never steal focus, and let the pointer through
        // so moving to the next tile doesn't fight the popover.
        onOpenAutoFocus={(e) => {
          if (!target?.pinned) e.preventDefault()
        }}
        // A click on the CANVAS is ours to interpret (pin this tile, re-pin
        // another, or close on the background). Without this, Radix's dismiss
        // races the same click and cancels the pin — so the first click looked
        // like it did nothing and only a double-click appeared to work. Clicks
        // truly outside (header, sidebar) still dismiss normally.
        onPointerDownOutside={(e) => {
          const t = e.detail.originalEvent.target as Element | null
          if (t?.closest?.("[data-floor-canvas]")) e.preventDefault()
        }}
        style={target?.pinned ? undefined : { pointerEvents: "none" }}
      >
        {ctx && (
          <>
            <p className="truncate text-sm font-medium">
              {tileName(ctx.tile) ||
                ctx.tile.tile_type?.name ||
                ctx.tile.role_type?.name ||
                "Tile"}
            </p>
            <dl className="mt-2 grid gap-1 text-[13px]">
              {rows.map((r) => (
                <div key={r.key} className="grid grid-cols-[5.5rem_1fr] gap-2">
                  <dt className="text-[11px] text-muted-foreground">
                    {r.label}
                  </dt>
                  <dd className="min-w-0 truncate">{r.node}</dd>
                </div>
              ))}
            </dl>
            {loading && (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Loading object details…
              </p>
            )}
            {target?.pinned ? (
              renderActions?.(ctx.tile)
            ) : (
              <p className="mt-2 text-[10px] text-muted-foreground">
                Click to pin
              </p>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  )
}

/**
 * Hover/pin state for the popover, with the open delay.
 *
 * Kept here so the page just forwards the canvas's `onHoverTile` and clicks.
 */
export function useTilePopover(delayMs = 250) {
  const [target, setTarget] = useState<HoverTarget | null>(null)
  const timer = useRef<number | null>(null)
  // Mirrors target.pinned. A ref (not state) so the hover handler and the
  // pending timer both read the CURRENT value without re-subscribing.
  const pinned = useRef(false)
  // The last tile+point the pointer entered, recorded immediately (before the
  // open delay). A click is always preceded by a pointerenter on that tile, so
  // this is where `pinCurrent()` gets its coords — the canvas's select callback
  // only carries an id.
  const lastHover = useRef<HoverTarget | null>(null)

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current)
      timer.current = null
    }
  }
  useEffect(() => clearTimer, [])

  /** Canvas hover in/out. A pinned popover ignores hover entirely. */
  const onHover = (
    tile: FloorPlanTile | null,
    at: { x: number; y: number } | null
  ) => {
    lastHover.current = tile && at ? { tile, ...at, pinned: false } : null
    if (pinned.current) return
    clearTimer()
    if (!tile || !at) {
      setTarget(null)
      return
    }
    timer.current = window.setTimeout(() => {
      if (pinned.current) return // pinned while we waited
      setTarget({ tile, x: at.x, y: at.y, pinned: false })
    }, delayMs)
  }

  /** Pin whatever the pointer is currently over — the click path. Returns false
   * when the pointer isn't over a tile (a background click), so the caller can
   * treat that as a dismiss. */
  const pinCurrent = () => {
    const hit = lastHover.current
    if (!hit) return false
    clearTimer()
    pinned.current = true
    setTarget({ ...hit, pinned: true })
    return true
  }

  const close = () => {
    clearTimer()
    pinned.current = false
    setTarget(null)
  }

  return { target, onHover, pinCurrent, close }
}
