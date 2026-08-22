import * as React from "react"
import { useEffect, useMemo, useRef, useState } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api, formatBytes } from "@/lib/api"
import type {
  DeviceSnmp,
  DeviceType,
  FacePort,
  FacePorts,
  Interface,
  InventoryItemRow,
  Paginated,
  SnmpDriftItem,
  TerminationKind,
  VLANMini,
} from "@/lib/api"
import {
  CONNECTOR_MM,
  MIN_LABEL_PX,
  normalizePortName,
  PANEL_MM,
  PX_PER_MM,
  renderTemplateName,
} from "@/lib/faceplate-geometry"
import {
  bayHex,
  EMPTY_LEGEND,
  legendContent,
  PORT_NEUTRAL,
  portCapabilityHex,
  portHex,
  portOverlayStyle,
  portState,
  portTintStyle,
  type LegendContent,
  type PortState,
} from "@/lib/faceplate-colors"
import {
  HardwareStatusKey,
  AirflowKey,
  ModuleBayKey,
  SpeedScale,
  useReportLegend,
  type LegendReporter,
} from "@/components/speed-scale"
import { InventoryItemDialog } from "@/components/device-inventory-pane"
import { InstallModuleDialog } from "@/components/device-modules-pane"
import { CableForm } from "@/components/cable-form"
import { VlanBadge } from "@/components/cells/vlan-badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { useMe } from "@/lib/use-me"
import {
  autoLayout,
  composeModuleFaceplates,
  markerTerminationKind,
  resolveLayout,
  type FaceplateDoc,
  type FaceplateSide,
  type PortComponent,
  type ResolvedFaceplate,
  type ResolvedGroup,
  type ResolvedSlot,
  type SlotKind,
} from "@/lib/faceplate-layout"
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card"
import { cableState } from "@/lib/cable-state"
import { cn } from "@/lib/utils"

/**
 * Draws a device's front panel at millimetre-true scale - the "switch
 * builder". Connector cages are sized from real form-factor dimensions
 * (SFF-8432 SFP, QSFP MSA, EIA-310 panel), so an SFP28 field reads narrower
 * than the QSFP28 uplinks beside it, exactly like the hardware. Layout comes
 * from the device type's saved faceplate document when one exists (the
 * drag-and-drop builder), else from `autoLayout()` - same doc shape either
 * way, one render path. Color carries state only; every interface links to
 * its page and carries a tooltip; live SNMP facts overlay as dots.
 */

/** Live (observed) facts for one port, keyed by normalized interface name -
 * read-only SNMP data drawn OVER the intent, never instead of it. */
export interface ObservedPort {
  oper_status: string
  admin_status: string
  speed_mbps: string
}

// normalizePortName moved to the pure-geometry lib so the 3D world math (and
// its tests) can share it; re-exported because consumers import it from here.
export { normalizePortName }

/** Observed per-port facts from the device's last SNMP poll - shares the
 * ["device-snmp", id] cache with the SNMP tab, so no extra polling. Returns
 * null until data exists (device never polled / SNMP not set up). */
export function useObservedPorts(
  deviceId: string | undefined
): Map<string, ObservedPort> | null {
  const q = useQuery({
    queryKey: ["device-snmp", deviceId],
    queryFn: () => api<DeviceSnmp>(`/api/monitoring/devices/${deviceId}/snmp/`),
    enabled: !!deviceId,
    staleTime: 60_000,
  })
  return useMemo(() => {
    const rows = q.data?.interfaces ?? []
    if (rows.length === 0) return null
    const map = new Map<string, ObservedPort>()
    for (const o of rows) {
      if (!o.name) continue
      map.set(normalizePortName(o.name), {
        oper_status: o.oper_status,
        admin_status: o.admin_status,
        speed_mbps: o.speed_mbps,
      })
    }
    return map.size ? map : null
  }, [q.data])
}

// UniFi-style speed tint on cabled ports: ≥10G sky, 1–5G emerald, <1G amber.
// State logic + hex mirror live in `@/lib/faceplate-colors` (shared with 3D);
// these are the 2D CSS classes for the same states.
const PORT_STATE_CLASS: Record<PortState, string> = {
  fast: "border-sky-500/70 bg-sky-500/15 text-sky-700 dark:text-sky-300",
  gig: "border-emerald-500/70 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  slow: "border-amber-500/70 bg-amber-500/15 text-amber-700 dark:text-amber-300",
  cabled:
    "border-emerald-500/70 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  free: "border-border bg-muted/40 text-muted-foreground",
  disabled: "border-dashed border-border/70 text-muted-foreground/40",
}

function VlanLink({ vlan }: { vlan: VLANMini }) {
  return <VlanBadge vlan={vlan} />
}

function VlanRow({ i }: { i: Interface }) {
  const trunk = i.mode === "tagged" || i.mode === "tagged-all"
  if (trunk)
    return (
      <>
        trunk
        {i.vlan && (
          <>
            {" · native "}
            <VlanLink vlan={i.vlan} />
          </>
        )}
        {i.mode === "tagged-all"
          ? " · all VLANs"
          : i.tagged_vlans.length
            ? ` · ${i.tagged_vlans.length} tagged`
            : null}
      </>
    )
  if (i.vlan)
    return (
      <>
        {"access · "}
        <VlanLink vlan={i.vlan} />
      </>
    )
  return null
}

function liveDotClass(o: ObservedPort): string {
  if (o.admin_status === "down") return "bg-zinc-400 dark:bg-zinc-600"
  return o.oper_status === "up" ? "bg-emerald-500" : "bg-red-500"
}

function liveLine(o: ObservedPort): string {
  if (o.admin_status === "down") return "live: admin down"
  const speed =
    o.oper_status === "up" && o.speed_mbps && Number(o.speed_mbps) > 0
      ? ` · ${Number(o.speed_mbps) >= 1000 ? `${Number(o.speed_mbps) / 1000}G` : `${o.speed_mbps}M`}`
      : ""
  return `live: ${o.oper_status || "?"}${speed}`
}

// ─── port cage ──────────────────────────────────────────────────────────────

/** One connector cage, mm-sized. Interfaces get state color + link + hover
 * card; other component kinds render as static cages with a title tooltip;
 * unmatched ports are dashed ghosts; blanks are empty cages. */
function Cage({
  r,
  scale,
  observed,
}: {
  r: ResolvedSlot
  scale: number
  observed?: ObservedPort
}) {
  const dims = CONNECTOR_MM[r.family]
  const style = {
    width: Math.round(dims.w * scale),
    height: Math.round(dims.h * scale),
  }
  const showNum = style.width >= MIN_LABEL_PX

  if (r.slot.t === "label") {
    return (
      <span className="flex items-center px-0.5 font-mono text-[9px] whitespace-nowrap text-muted-foreground">
        {r.slot.text}
      </span>
    )
  }

  if (r.slot.t === "blank" || (r.slot.t === "port" && !r.component)) {
    // Unpopulated cage / layout slot whose component is gone → ghost.
    return (
      <span
        style={style}
        title={r.slot.t === "port" ? `${r.slot.name} (missing)` : undefined}
        className="num flex items-center justify-center rounded-[3px] border border-dashed border-border/60 text-[9px] leading-none text-muted-foreground/40"
      >
        {r.slot.t === "port" && showNum ? (r.num ?? "·") : ""}
      </span>
    )
  }

  // Non-interface component (console / power / aux / panel port): static cage.
  if (r.kind !== "interface" || !r.iface) {
    return (
      <span
        style={style}
        title={`${r.component!.name}${r.component!.type ? ` · ${r.component!.type}` : ""}`}
        className="num flex items-center justify-center rounded-[3px] border border-border bg-muted/40 text-[9px] leading-none font-medium text-muted-foreground"
      >
        {showNum ? (r.num ?? "·") : ""}
      </span>
    )
  }

  const i = r.iface
  const state = portState(i)
  const trunk = i.mode === "tagged" || i.mode === "tagged-all"
  const hasVlan = trunk || !!i.vlan
  // Cabled ports wear their speed TIER (shared ramp); free ports get a muted
  // capability outline from their type's max speed; disabled stays neutral.
  const tint = { ...i, type: i.type_display || i.type }
  const cabled = state !== "free" && state !== "disabled"
  const capability = portCapabilityHex(tint)
  return (
    <HoverCard openDelay={100} closeDelay={80}>
      <HoverCardTrigger asChild>
        <Link
          to="/interfaces/$id"
          params={{ id: i.id }}
          data-cable-state={cableState(i)}
          style={
            cabled
              ? { ...style, ...portTintStyle(portHex(tint)) }
              : cableState(i) === "reserved"
                ? // Directly reserved (no cable yet) - amber outline so the
                  // hold reads on the panel, matching the utilization card.
                  {
                    ...style,
                    borderColor: "#f59e0bb3",
                    ["--port-color" as never]: "#f59e0b",
                  }
                : capability
                  ? {
                      ...style,
                      borderColor: `${capability}73`,
                      ["--port-color" as never]: capability,
                    }
                  : { ...style, ["--port-color" as never]: "#a1a1aa" }
          }
          className={cn(
            "num relative flex items-center justify-center rounded-[3px] border text-[9px] leading-none font-medium transition-colors hover:border-primary hover:text-foreground",
            !cabled && PORT_STATE_CLASS[state]
          )}
        >
          {showNum ? (r.num ?? "·") : ""}
          {trunk && (
            <span
              className="absolute inset-x-1 top-0 h-[2px] rounded-b bg-current opacity-70"
              aria-hidden
            />
          )}
          {observed && (
            <span
              className={cn(
                "absolute -right-0.5 -bottom-0.5 h-1.5 w-1.5 rounded-full ring-1 ring-background",
                liveDotClass(observed)
              )}
              aria-hidden
            />
          )}
        </Link>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        className="grid gap-0.5 font-mono text-[11px] whitespace-nowrap"
      >
        <PortHoverBody
          i={i}
          state={state}
          hasVlan={hasVlan}
          observed={observed}
        />
      </HoverCardContent>
    </HoverCard>
  )
}

// ─── configurable hover card ────────────────────────────────────────────────

const PORT_POPOVER_DEFAULTS = ["name", "type", "state", "vlan", "live", "ips"]

/** The admin-ordered field list for the port hover card - the component
 * analogue of the floor-plan tile popover (Settings → Components). */
function usePortPopoverFields(): string[] {
  const q = useQuery({
    queryKey: ["component-popover"],
    queryFn: () => api<{ fields: string[] }>("/api/component-popover/"),
    staleTime: 5 * 60_000,
  })
  return q.data?.fields ?? PORT_POPOVER_DEFAULTS
}

function PortHoverBody({
  i,
  state,
  hasVlan,
  observed,
}: {
  i: Interface
  state: PortState
  hasVlan: boolean
  observed?: ObservedPort
}) {
  const fields = usePortPopoverFields()
  const rows: Record<string, React.ReactNode> = {
    name: (
      <Link
        to="/interfaces/$id"
        params={{ id: i.id }}
        className="link font-semibold"
      >
        {i.name}
      </Link>
    ),
    type: i.type_display ? <div>{i.type_display}</div> : null,
    state: (
      <div>
        {state === "disabled"
          ? "disabled"
          : state === "free"
            ? "enabled · no cable"
            : `up${i.speed ? ` · ${i.speed}` : ""}${
                i.cable?.type ? ` · ${i.cable.type}` : ""
              }`}
      </div>
    ),
    vlan: hasVlan ? (
      <div>
        <VlanRow i={i} />
      </div>
    ) : null,
    live: observed ? (
      <div className="text-muted-foreground">{liveLine(observed)}</div>
    ) : null,
    ips: i.ip_addresses.length ? (
      <>
        {i.ip_addresses.slice(0, 3).map((ip) => (
          <Link
            key={ip.id}
            to="/ips/$id"
            params={{ id: ip.id }}
            className="link"
          >
            {ip.ip_address}
          </Link>
        ))}
      </>
    ) : null,
    description: i.description ? (
      <div className="max-w-56 truncate text-muted-foreground">
        {i.description}
      </div>
    ) : null,
    mac: i.mac_address ? <div>{i.mac_address}</div> : null,
    mtu: i.mtu != null ? <div>MTU {i.mtu}</div> : null,
    lag: i.lag ? <div>LAG {i.lag.name}</div> : null,
    tags: i.tags.length ? (
      <div className="text-muted-foreground">
        {i.tags.map((t) => t.name).join(", ")}
      </div>
    ) : null,
  }
  return (
    <>
      {fields.map((key) => (
        <React.Fragment key={key}>{rows[key] ?? null}</React.Fragment>
      ))}
    </>
  )
}

// ─── group (banked zigzag grid) ─────────────────────────────────────────────

function chunk<T>(list: T[], size: number): T[][] {
  if (size <= 0) return [list]
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function GroupBlock({
  group: g,
  scale,
  observed,
}: {
  group: ResolvedGroup
  scale: number
  observed?: Map<string, ObservedPort> | null
}) {
  const cells = g.resolved.filter((r) => r.slot.t !== "label")
  const labels = g.resolved.filter((r) => r.slot.t === "label")
  const pitch = Math.max(...cells.map((r) => CONNECTOR_MM[r.family].pitch), 0)
  const maxW = Math.max(...cells.map((r) => CONNECTOR_MM[r.family].w), 0)
  const colGap = Math.max(0, Math.round((pitch - maxW) * scale))
  const rowGap = Math.round(PANEL_MM.rowGap * scale)
  const banks = chunk(cells, g.bank > 0 ? g.bank : cells.length)

  return (
    <div
      className="flex items-center gap-2"
      style={g.gapMm ? { marginLeft: Math.round(g.gapMm * scale) } : undefined}
    >
      {g.label && (
        <span className="num w-fit shrink-0 font-mono text-[9px] text-muted-foreground">
          {g.label}
        </span>
      )}
      {labels.map((r, i) => (
        <Cage key={`lbl-${i}`} r={r} scale={scale} />
      ))}
      <div
        className="flex items-center"
        style={{ gap: Math.round(PANEL_MM.bankGap * scale) }}
      >
        {banks.map((bank, bi) => (
          <div
            key={bi}
            className="grid grid-flow-col items-center justify-items-center"
            style={{
              gridTemplateRows: `repeat(${g.rows}, minmax(0, 1fr))`,
              columnGap: colGap,
              rowGap,
            }}
          >
            {bank.map((r, i) => (
              <Cage
                key={
                  r.component?.id ??
                  `${g.id}-${bi}-${i}` /* blanks/ghosts have no id */
                }
                r={r}
                scale={scale}
                observed={
                  r.iface
                    ? observed?.get(normalizePortName(r.iface.name))
                    : undefined
                }
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

/** Resolved groups arranged into per-U lanes (`g.u`, default 1), stacked
 * vertically - a 2U device draws its slot-1 groups above its slot-2 groups.
 * Dividers separate adjacent groups of different families within a lane. */
function FaceplateLanes({
  resolved,
  scale,
  observed,
}: {
  resolved: ResolvedFaceplate
  scale: number
  observed?: Map<string, ObservedPort> | null
}) {
  const byLane = new Map<number, ResolvedGroup[]>()
  for (const g of resolved.groups) {
    const lane = g.u ?? 1
    const list = byLane.get(lane)
    if (list) list.push(g)
    else byLane.set(lane, [g])
  }
  const laneNos = [...byLane.keys()].sort((a, b) => a - b)
  const multi = laneNos.length > 1

  return (
    <div
      className="flex flex-col justify-center"
      style={{ rowGap: Math.round(PANEL_MM.rowGap * 2 * scale) }}
    >
      {laneNos.map((no) => {
        const laneGroups = byLane.get(no)!
        // A group spanning >1 U makes its lane that many units tall.
        const spanU = laneGroups.reduce((m, g) => Math.max(m, g.uSpan ?? 1), 1)
        const perU = Math.round(PANEL_MM.face * scale * 0.85)
        return (
          <div
            key={no}
            className="flex items-center"
            style={{
              columnGap: Math.round(PANEL_MM.groupGap * scale),
              minHeight: multi || spanU > 1 ? perU * spanU : undefined,
            }}
          >
            {laneGroups.map((g, i) => {
              const prev = laneGroups[i - 1]
              const divider = prev && prev.family !== g.family
              return (
                <div
                  key={g.id}
                  className="flex items-center"
                  style={{ columnGap: Math.round(PANEL_MM.groupGap * scale) }}
                >
                  {divider && <div className="h-8 w-px shrink-0 bg-border" />}
                  <GroupBlock group={g} scale={scale} observed={observed} />
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ─── scale resolution ───────────────────────────────────────────────────────

function useContainerWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setWidth(w)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width]
}

// Component kinds a saved layout may reference and their list endpoints -
// fetched lazily, only when a doc actually places that kind.
const KIND_LIST_ENDPOINT: Record<Exclude<SlotKind, "interface">, string> = {
  "console-port": "console-ports",
  "console-server-port": "console-server-ports",
  "power-port": "power-ports",
  "power-outlet": "power-outlets",
  "front-port": "front-ports",
  "rear-port": "rear-ports",
  "aux-port": "aux-ports",
}

const NON_INTERFACE_KINDS = Object.keys(
  KIND_LIST_ENDPOINT
) as (keyof typeof KIND_LIST_ENDPOINT)[]

// ─── main component ─────────────────────────────────────────────────────────

type InstalledModule = {
  id: string
  module_bay: { id: string; name: string; position: string }
  module_type_faceplate: FaceplateDoc | null
  module_interfaces?: { name: string; type?: string }[]
}

export function DeviceFaceplate({
  interfaces,
  deviceId,
  deviceTypeId,
  vcPosition,
  side = "front",
  fit,
  className,
  observed,
  onLegend,
  legendKey = "panel",
}: {
  interfaces: Interface[]
  /** Enables resolving non-interface components a saved layout places. */
  deviceId?: string
  /** Enables the device type's saved faceplate layout. */
  deviceTypeId?: string | null
  /** Stack member number - resolves `{position}` in saved slot names. */
  vcPosition?: number | null
  /** Which panel to draw - rear exists only via a saved layout. */
  side?: FaceplateSide
  /** "container" = fit panel to wrapper width (clamped); number = px/mm;
   * default = fixed 1.6 px/mm (stack bars - their container is w-fit). */
  fit?: "container" | number
  className?: string
  /** Live SNMP facts by normalized port name (see useObservedPorts). Adds a
   * status dot per port + a "live:" tooltip line - decoration only; the
   * source-of-truth styling is untouched. */
  observed?: Map<string, ObservedPort> | null
  /** Report the colours this panel actually uses (see `useLegendCollector`). */
  onLegend?: LegendReporter
  /** Identifies this panel to the collector - a stack passes one key per
   * member so the legend unions them. */
  legendKey?: string
}) {
  const physical = useMemo(
    () => interfaces.filter((i) => !i.virtual),
    [interfaces]
  )

  // Saved layout from the device type (shared cache with the detail page).
  const dt = useQuery({
    queryKey: ["device-type", deviceTypeId],
    queryFn: () => api<DeviceType>(`/api/device-types/${deviceTypeId}/`),
    enabled: !!deviceTypeId,
    staleTime: 5 * 60_000,
  })
  const savedDoc: FaceplateDoc | null = dt.data?.faceplate ?? null

  // Installed modules whose TYPE has a saved faceplate get composed into the
  // device render at their bay - slot names resolved {module} → bay position
  // (then {position} resolves with the rest of the pipeline), so the cages
  // match the interfaces the install stamped onto the device.
  const modulesQ = useQuery({
    queryKey: ["device-modules-faceplate", deviceId],
    queryFn: () =>
      api<Paginated<InstalledModule>>(`/api/modules/?device=${deviceId}`),
    enabled: !!deviceId,
    staleTime: 60_000,
  })
  const doc = useMemo<FaceplateDoc>(
    () =>
      composeModuleFaceplates(
        savedDoc ?? autoLayout(physical),
        modulesQ.data?.results ?? []
      ),
    [savedDoc, physical, modulesQ.data]
  )

  // Lazily fetch the non-interface component lists the doc references.
  const kindsNeeded = useMemo(
    () =>
      NON_INTERFACE_KINDS.filter((k) =>
        [...doc.front, ...doc.rear].some((g) =>
          g.slots.some((s) => s.t === "port" && (s.kind ?? "interface") === k)
        )
      ),
    [doc]
  )
  const kindQueries = useQueries({
    queries: kindsNeeded.map((k) => ({
      queryKey: ["faceplate-components", k, deviceId],
      queryFn: () =>
        api<Paginated<PortComponent>>(
          `/api/${KIND_LIST_ENDPOINT[k]}/?device=${deviceId}&page_size=500`
        ),
      enabled: !!deviceId,
      staleTime: 60_000,
    })),
  })

  const resolved: ResolvedFaceplate = useMemo(() => {
    const componentsByKind: Partial<Record<SlotKind, PortComponent[]>> = {
      interface: physical,
    }
    kindsNeeded.forEach((k, i) => {
      componentsByKind[k] = kindQueries[i]?.data?.results ?? []
    })
    return resolveLayout(
      doc,
      side,
      componentsByKind,
      vcPosition ?? null,
      physical
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    doc,
    side,
    physical,
    vcPosition,
    kindsNeeded,
    ...kindQueries.map((q) => q.data),
  ])

  // The cages this panel actually drew - a saved layout places a subset of the
  // device's ports, so the device's interface list is the wrong source.
  const legend = useMemo(() => {
    const drawn = resolved.groups.flatMap((g) => g.resolved)
    const obs = new Map<string, ObservedPort>()
    const ports: Parameters<typeof legendContent>[0]["ports"] = []
    for (const s of drawn) {
      if (!s.iface) continue
      ports.push({
        enabled: s.iface.enabled,
        cable: s.iface.cable,
        speed: s.iface.speed,
        type: s.iface.type_display || s.iface.type,
        mode: s.iface.mode,
      })
      const key = normalizePortName(s.iface.name)
      const live = observed?.get(key)
      if (live) obs.set(key, live)
    }
    return legendContent({ ports, observed: obs })
  }, [resolved, observed])
  useReportLegend(onLegend, legendKey, legend)

  const [wrapRef, containerWidth] = useContainerWidth()
  // "Full width" layouts render the whole blade even when sparsely populated
  // (a rear side with two PSUs shouldn't hug into a tiny box). The blade is
  // the type's actual footprint - half-width gear draws half the opening.
  const fullWidth = !!savedDoc?.full
  const bladeMm = PANEL_MM.opening * (dt.data?.rack_width === "half" ? 0.5 : 1)
  const panelSpanMm = fullWidth
    ? Math.max(resolved.spanMm, bladeMm)
    : resolved.spanMm
  const scale =
    fit === "container"
      ? containerWidth > 0 && panelSpanMm > 0
        ? Math.min(
            Math.max(containerWidth / (panelSpanMm + 8), PX_PER_MM.min),
            PX_PER_MM.max
          )
        : PX_PER_MM.default
      : (fit ?? PX_PER_MM.default)
  // Bar height follows the type's rack height - a 2U device draws a 2U blade.
  const uHeight = Math.max(1, dt.data?.u_height ?? 1)
  const faceMm = PANEL_MM.uPitch * (uHeight - 1) + PANEL_MM.face

  if (resolved.groups.length === 0) return null

  const panel = (
    <div
      className={cn(
        "flex w-fit max-w-full items-center overflow-x-auto rounded-md border border-border bg-muted/30 px-2",
        className
      )}
      style={{
        columnGap: Math.round(PANEL_MM.groupGap * scale),
        minHeight: Math.round(faceMm * scale * 0.9),
        minWidth: fullWidth
          ? Math.min(
              Math.round(bladeMm * scale),
              containerWidth || Number.MAX_SAFE_INTEGER
            )
          : undefined,
        paddingTop: 4,
        paddingBottom: 4,
      }}
    >
      <FaceplateLanes resolved={resolved} scale={scale} observed={observed} />
    </div>
  )

  if (fit === "container")
    return (
      <div ref={wrapRef} className="w-full">
        {panel}
      </div>
    )
  return panel
}

/** Template-driven, non-interactive faceplate - draws a device TYPE as
 * hardware without touching per-device state. Used by rack elevations'
 * "Render" mode: templates + the saved layout are cached per TYPE, so a rack
 * of twenty identical switches costs one fetch, not twenty. */
export function TypeFaceplate({
  deviceTypeId,
  side = "front",
  pxPerMm,
  vcPosition = null,
  compact = false,
  className,
}: {
  deviceTypeId: string
  side?: FaceplateSide
  /** Max scale (px per mm) - the panel shrinks below this to fit its
   * container so every port stays visible. */
  pxPerMm: number
  vcPosition?: number | null
  /** Strip group captions (rack-elevation scale). */
  compact?: boolean
  className?: string
}) {
  const dt = useQuery({
    queryKey: ["device-type", deviceTypeId],
    queryFn: () => api<DeviceType>(`/api/device-types/${deviceTypeId}/`),
    staleTime: 5 * 60_000,
  })
  const savedDoc = dt.data?.faceplate ?? null

  // Interface templates always (auto layout needs them); other kinds only
  // when the saved doc places them. Query keys match the builder's.
  const ifaceTpls = useQuery({
    queryKey: ["dt-interface-templates", deviceTypeId],
    queryFn: () =>
      api<Paginated<PortComponent>>(
        `/api/interface-templates/?device_type=${deviceTypeId}`
      ),
    staleTime: 5 * 60_000,
  })
  const kindsNeeded = useMemo(
    () =>
      savedDoc
        ? NON_INTERFACE_KINDS.filter((k) =>
            [...savedDoc.front, ...savedDoc.rear].some((g) =>
              g.slots.some(
                (s) => s.t === "port" && (s.kind ?? "interface") === k
              )
            )
          )
        : [],
    [savedDoc]
  )
  const kindQueries = useQueries({
    queries: kindsNeeded.map((k) => ({
      queryKey: [`dt-${k}-templates`, deviceTypeId],
      queryFn: () =>
        api<Paginated<PortComponent>>(
          `/api/${KIND_LIST_ENDPOINT[k].replace(/s$/, "")}-templates/?device_type=${deviceTypeId}`
        ),
      staleTime: 5 * 60_000,
    })),
  })

  const resolved = useMemo(() => {
    // Render {position} in template names so slots (also rendered) match.
    const render = (list: PortComponent[] = []) =>
      list.map((t) => ({ ...t, name: renderTemplateName(t.name, vcPosition) }))
    const componentsByKind: Partial<Record<SlotKind, PortComponent[]>> = {
      interface: render(ifaceTpls.data?.results),
    }
    kindsNeeded.forEach((k, i) => {
      componentsByKind[k] = render(kindQueries[i]?.data?.results)
    })
    const doc = savedDoc ?? autoLayout(componentsByKind.interface ?? [])
    const out = resolveLayout(doc, side, componentsByKind, vcPosition)
    if (compact) {
      // Rack scale: group captions just clutter - drop them (ports remain).
      return {
        ...out,
        groups: out.groups.map((g) => ({ ...g, label: undefined })),
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    savedDoc,
    side,
    vcPosition,
    compact,
    ifaceTpls.data,
    kindsNeeded,
    ...kindQueries.map((q) => q.data),
  ])

  // Fit-to-container: measure the wrapper and scale the panel to fill it, so
  // every port renders regardless of the block's width. pxPerMm caps the max.
  const [wrapRef, width] = useContainerWidth()
  const scale =
    width > 0 && resolved.spanMm > 0
      ? Math.min(pxPerMm, Math.max(0.35, width / (resolved.spanMm + 4)))
      : pxPerMm

  if (resolved.groups.length === 0) return null
  return (
    <div ref={wrapRef} className={cn("w-full min-w-0", className)}>
      <FaceplateLanes resolved={resolved} scale={scale} />
    </div>
  )
}

export type FaceplateMode = "image" | "rendered"

/**
 * One faceplate, either way. `mode="image"` draws the device type's PHOTO with
 * ports marked on it when the type actually has a photo + markers; otherwise -
 * and for `mode="rendered"` - it draws the schematic faceplate. So a caller
 * can offer an Image/Rendered toggle and default to the photo without having
 * to branch, and a type with no photo silently falls back to the schematic.
 */
export function FaceplateView({
  mode = "image",
  deviceTypeId,
  deviceId,
  interfaces,
  vcPosition,
  side = "front",
  observed,
  onLegend,
  legendKey = "panel",
  className,
  fit,
}: {
  mode?: FaceplateMode
  deviceTypeId?: string | null
  deviceId?: string
  interfaces: Interface[]
  vcPosition?: number | null
  side?: FaceplateSide
  observed?: Map<string, ObservedPort> | null
  onLegend?: LegendReporter
  legendKey?: string
  className?: string
  fit?: "container" | number
}) {
  const hasImage = useHasImagePorts(deviceTypeId)
  if (mode === "image" && hasImage && deviceTypeId) {
    return (
      <ImagePortsFaceplate
        deviceTypeId={deviceTypeId}
        deviceId={deviceId}
        interfaces={interfaces}
        vcPosition={vcPosition}
        side={side}
        observed={observed}
        onLegend={onLegend}
        legendKey={legendKey}
        className={className}
      />
    )
  }
  return (
    <DeviceFaceplate
      interfaces={interfaces}
      deviceId={deviceId}
      deviceTypeId={deviceTypeId}
      vcPosition={vcPosition}
      side={side}
      fit={fit}
      observed={observed}
      onLegend={onLegend}
      legendKey={legendKey}
      className={className}
    />
  )
}

// ─── image-anchored ports (photo faceplate) ─────────────────────────────────

/** True when a device type has a photo + at least one placed port marker on
 * either side - i.e. the image faceplate should render instead of the
 * schematic one. Shares the ["device-type", id] cache. */
export function useHasImagePorts(deviceTypeId?: string | null): boolean {
  const dt = useQuery({
    queryKey: ["device-type", deviceTypeId],
    queryFn: () => api<DeviceType>(`/api/device-types/${deviceTypeId}/`),
    enabled: !!deviceTypeId,
    staleTime: 5 * 60_000,
  })
  const ip = dt.data?.image_ports
  const hasImg = !!(dt.data?.front_image || dt.data?.rear_image)
  return hasImg && !!ip && (ip.front.length > 0 || ip.rear.length > 0)
}

/**
 * A device's front/rear PHOTO with its interface ports marked directly on the
 * image - the "photo faceplate". Markers come from the device type's
 * `image_ports` (normalized 0..1, center-anchored); each is matched to the
 * device's real interface by name (`{position}`-rendered), so it carries the
 * same state color, live SNMP dot, hover card and link as the schematic
 * faceplate. Coexists with it - the caller picks which to show.
 */
export function ImagePortsFaceplate({
  deviceTypeId,
  deviceId,
  interfaces,
  vcPosition,
  side,
  observed,
  onLegend,
  legendKey = "panel",
  className,
}: {
  deviceTypeId: string
  /** Resolves hardware (inventory-item) markers to the device's real parts -
   * status-coloured disk bays etc. Optional; without it they render ghosts. */
  deviceId?: string
  interfaces: Interface[]
  vcPosition?: number | null
  side: FaceplateSide
  observed?: Map<string, ObservedPort> | null
  /** Report the colours this panel actually uses, so a legend can key just
   * those - a shelf of disk bays shouldn't explain 400G. */
  onLegend?: LegendReporter
  /** Identifies this panel to the collector; default fits one panel per page. */
  legendKey?: string
  className?: string
}) {
  const { canDo } = useMe()
  // Editing a bay writes to the device's parts, so it needs the same permission
  // the Hardware tab does - and a device to write them to. Module bays install
  // through the same gate (matching the Modules pane).
  const canEditParts = !!deviceId && canDo("device", "change")
  // Cabling a free power/console/aux/panel port from its marker.
  const canConnect = !!deviceId && canDo("cable", "add")
  const [partDialog, setPartDialog] = useState<{
    item: InventoryItemRow | null
    /** The marker's rendered name - the bay being filled, when creating. */
    name: string
  } | null>(null)
  // An empty module-bay marker was clicked - install into it.
  const [installBay, setInstallBay] = useState<{
    id: string
    name: string
  } | null>(null)
  // A free non-interface port marker was clicked - connect a cable from it.
  const [connect, setConnect] = useState<{
    id: string
    kind: TerminationKind
    name: string
  } | null>(null)
  const dt = useQuery({
    queryKey: ["device-type", deviceTypeId],
    queryFn: () => api<DeviceType>(`/api/device-types/${deviceTypeId}/`),
    enabled: !!deviceTypeId,
    staleTime: 5 * 60_000,
  })
  const ifaceByName = useMemo(
    () => new Map(interfaces.map((i) => [normalizePortName(i.name), i])),
    [interfaces]
  )
  // For the connect dialog's title - callers pass this device's own
  // interfaces, so any row names the device.
  const deviceName = interfaces.at(0)?.device.name ?? ""

  const image = side === "front" ? dt.data?.front_image : dt.data?.rear_image
  // Memoized: the legend derives from these, and a fresh `[]` every render
  // would make it recompute (and re-report) forever.
  const markers = useMemo(
    () => dt.data?.image_ports?.[side] ?? [],
    [dt.data, side]
  )
  const wantsInventory =
    !!deviceId && markers.some((m) => m.kind === "inventory-item")
  // Console / power / aux / panel-port markers resolve through the same
  // /face-ports/ payload the 3D room uses. Without this they fell through to
  // the "not on this device" ghost even when the component was right there -
  // this component knew only two of the nine kinds, while 3D knew them all.
  const wantsFacePorts =
    !!deviceId &&
    markers.some(
      (m) => m.kind && m.kind !== "interface" && m.kind !== "inventory-item"
    )
  const facePorts = useQuery({
    queryKey: ["device-face-ports", deviceId],
    queryFn: () => api<FacePorts>(`/api/devices/${deviceId}/face-ports/`),
    enabled: wantsFacePorts,
    staleTime: 30_000,
  })
  const portByMarker = useMemo(() => {
    const map = new Map<string, FacePort>()
    const d = facePorts.data
    if (d) for (const p of [...d.front, ...d.rear]) map.set(p.marker, p)
    return map
  }, [facePorts.data])
  const inventory = useQuery({
    queryKey: ["device-inventory", deviceId],
    queryFn: () =>
      api<Paginated<InventoryItemRow>>(
        `/api/inventory-items/?device=${deviceId}&page_size=500`
      ),
    enabled: wantsInventory,
  })
  // Last raw sensor readings, so a bay's popover can show what the agent
  // actually returned ("Normal", "4") rather than only the derived status.
  const sensorReadings = useQuery({
    queryKey: ["device-snmp", deviceId],
    queryFn: () =>
      api<{ sensors: { name: string; raw: string }[] }>(
        `/api/monitoring/devices/${deviceId}/snmp/`
      ),
    enabled: wantsInventory,
    staleTime: 60_000,
  })
  const sensorByName = useMemo(
    () =>
      new Map(
        (sensorReadings.data?.sensors ?? []).map((s) => [
          normalizePortName(s.name),
          s.raw,
        ])
      ),
    [sensorReadings.data]
  )
  // Observed-vs-set disagreements on this device's parts. Same query the
  // Monitoring tab and Hardware table use, so it costs nothing extra.
  const partDriftQuery = useQuery({
    queryKey: ["device-snmp-drift", deviceId],
    queryFn: () =>
      api<{ drift: SnmpDriftItem[] }>(
        `/api/monitoring/devices/${deviceId}/snmp/drift/`
      ),
    enabled: wantsInventory,
  })
  const partDrift = useMemo(() => {
    const map = new Map<string, string>()
    for (const d of partDriftQuery.data?.drift ?? [])
      if (d.kind === "part_status") map.set(d.part_id, d.observed)
    return map
  }, [partDriftQuery.data])
  const itemByName = useMemo(
    () =>
      new Map(
        (inventory.data?.results ?? []).map((i) => [
          normalizePortName(i.name),
          i,
        ])
      ),
    [inventory.data]
  )

  // What this panel puts on screen, walked exactly like the markers below:
  // only a marker that RESOLVED to something on this device is coloured, so
  // only it earns a legend entry. Unmatched markers draw as dashed ghosts and
  // carry no colour, hence no key.
  const legend = useMemo(() => {
    if (!image) return EMPTY_LEGEND
    const ports: Parameters<typeof legendContent>[0]["ports"] = []
    const parts: { status?: { id: string } | null }[] = []
    const bays: { occupied: boolean }[] = []
    const obs = new Map<string, ObservedPort>()
    for (const m of markers) {
      const kind = m.kind || "interface"
      const key = normalizePortName(
        renderTemplateName(m.name, vcPosition ?? null)
      )
      if (kind === "inventory-item") {
        const item = itemByName.get(key)
        if (item) parts.push(item)
        continue
      }
      if (kind === "module-bay") {
        // A bay that resolved is keyed by what's in it; one that didn't is a
        // ghost with no colour, so it earns no entry.
        const fp = portByMarker.get(m.name)
        if (fp?.id) bays.push({ occupied: !!fp.module })
        continue
      }
      if (kind !== "interface") {
        // Non-interface ports (power inlets, console, aux) wear the neutral
        // cabled/free tints. A free one is the "idle" swatch the key already
        // explains; a cabled one has NO speed tier to claim, so it stays out of
        // the ramp rather than dragging FE into the key.
        const fp = portByMarker.get(m.name)
        if (fp?.id && !fp.connected)
          ports.push({ enabled: true, cable: null, speed: "" })
        continue
      }
      const iface = ifaceByName.get(key)
      if (!iface) continue
      ports.push({
        enabled: iface.enabled,
        cable: iface.cable,
        speed: iface.speed,
        type: iface.type_display || iface.type,
        mode: iface.mode,
      })
      const live = observed?.get(key)
      if (live) obs.set(key, live)
    }
    return legendContent({ ports, observed: obs, parts, bays })
  }, [
    image,
    markers,
    vcPosition,
    ifaceByName,
    itemByName,
    portByMarker,
    observed,
  ])
  useReportLegend(onLegend, legendKey, legend)

  if (!image) return null

  return (
    <div
      className={cn(
        "relative w-full overflow-hidden rounded-md border border-border bg-muted/30",
        className
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={image}
        alt={`${side} panel`}
        className="block w-full select-none"
        draggable={false}
      />
      {markers.map((m, idx) => {
        // Interface markers resolve to a real interface (state + link);
        // other kinds render as a static marker with a name tooltip.
        const kind = m.kind || "interface"
        const name = renderTemplateName(m.name, vcPosition ?? null)
        const iface =
          kind === "interface"
            ? (ifaceByName.get(normalizePortName(name)) ?? null)
            : null
        const obs = observed?.get(normalizePortName(name))
        const style = {
          left: `${(m.x - m.w / 2) * 100}%`,
          top: `${(m.y - m.h / 2) * 100}%`,
          width: `${m.w * 100}%`,
          height: `${m.h * 100}%`,
        }
        // Hardware markers (disk bays…) - coloured by the PART's lifecycle
        // status (failed = red), not the port speed ramp.
        if (kind === "inventory-item") {
          const item = itemByName.get(normalizePortName(name))
          const hex = item?.status?.color || "#64748b"
          // An empty bay: the marker is drawn but no part fills it. With write
          // access it's the install affordance - click to fit hardware here,
          // named after the bay so a sensor keyed on that name picks it up.
          if (!item)
            return canEditParts ? (
              <button
                key={`${m.name}-${idx}`}
                type="button"
                style={style}
                title={`${name} - empty, click to install hardware`}
                onClick={() => setPartDialog({ item: null, name })}
                className="absolute cursor-pointer rounded-[2px] border border-dashed border-border/70 bg-background/20 hover:border-primary hover:bg-primary/10"
              />
            ) : (
              <span
                key={`${m.name}-${idx}`}
                style={style}
                title={`${name} (no matching part)`}
                className="absolute rounded-[2px] border border-dashed border-border/70 bg-background/20"
              />
            )
          return (
            <HoverCard key={`${m.name}-${idx}`} openDelay={100} closeDelay={80}>
              <HoverCardTrigger asChild>
                {canEditParts ? (
                  <button
                    type="button"
                    style={{
                      ...style,
                      borderColor: hex,
                      backgroundColor: `${hex}40`,
                    }}
                    title={
                      partDrift.get(item.id)
                        ? `${item.name} - SNMP says ${partDrift.get(item.id)}, click to review`
                        : `${item.name} - click to edit`
                    }
                    onClick={() => setPartDialog({ item, name })}
                    className={cn(
                      "absolute cursor-pointer rounded-[2px] border-2 transition-opacity hover:opacity-100 hover:ring-2 hover:ring-primary/40",
                      // Observed health disagrees with the set status: ring it
                      // rather than recolouring, so the bay keeps showing the
                      // SoT and the drift reads as a separate signal.
                      partDrift.get(item.id) &&
                        "ring-2 ring-amber-500 ring-offset-1 ring-offset-background"
                    )}
                  />
                ) : (
                  <span
                    style={{
                      ...style,
                      borderColor: hex,
                      backgroundColor: `${hex}40`,
                    }}
                    className="absolute rounded-[2px] border-2 transition-opacity hover:opacity-100"
                  />
                )}
              </HoverCardTrigger>
              <HoverCardContent
                side="top"
                className="grid gap-0.5 font-mono text-[11px] whitespace-nowrap"
              >
                <div className="font-semibold">{item.name}</div>
                <div className="text-muted-foreground">
                  {[
                    item.kind !== "other" ? item.kind : "",
                    item.media,
                    formatBytes(item.capacity_bytes),
                    item.speed,
                  ]
                    .filter(Boolean)
                    .join(" · ") || "hardware"}
                </div>
                {item.status && (
                  <div style={{ color: item.status.color || undefined }}>
                    {item.status.name}
                  </div>
                )}
                {item.manufacturer?.name && (
                  <div className="text-muted-foreground">
                    {item.manufacturer.name}
                    {item.part_id ? ` · ${item.part_id}` : ""}
                  </div>
                )}
                {item.serial_number && (
                  <div className="text-muted-foreground">
                    SN {item.serial_number}
                  </div>
                )}
                {item.asset_tag && (
                  <div className="text-muted-foreground">
                    Asset {item.asset_tag}
                  </div>
                )}
                {item.parent?.name && (
                  <div className="text-muted-foreground">
                    in {item.parent.name}
                  </div>
                )}
                {/* The last thing the sensors read for this part, so a red bay
                    says what the agent actually returned, not just "failed". */}
                {sensorByName.get(normalizePortName(name)) && (
                  <div className="text-muted-foreground">
                    SNMP {sensorByName.get(normalizePortName(name))}
                  </div>
                )}
                {/* Set status vs observed health, side by side - the difference
                    is the point, and accepting it stays in the drift inbox. */}
                {partDrift.get(item.id) && (
                  <div className="font-sans text-[10px] text-amber-600 dark:text-amber-400">
                    drift · SNMP says {partDrift.get(item.id)}
                  </div>
                )}
                {canEditParts && (
                  <div className="pt-0.5 font-sans text-[10px] text-muted-foreground">
                    Click to edit
                  </div>
                )}
              </HoverCardContent>
            </HoverCard>
          )
        }
        // Module bays (line-card slots) read OCCUPANCY: an installed bay is
        // filled, a free one is the same faint outline an idle port wears.
        // Without a device (a type preview) every bay is definitionally
        // unoccupied - that's an empty slot, not a broken marker.
        if (kind === "module-bay") {
          const fp = portByMarker.get(m.name)
          if (deviceId && !fp?.id)
            return (
              <span
                key={`${m.name}-${idx}`}
                style={style}
                title={`${name} (not on this device)`}
                className="absolute rounded-[2px] border border-dashed border-border/70 bg-background/20"
              />
            )
          const mod = fp?.module ?? null
          const hex = bayHex(!!mod)
          // An EMPTY bay on a real device is the install affordance - click to
          // seat a module, exactly like an empty disk bay installs hardware.
          // (Removal stays on the Modules pane; occupied bays just report.)
          const installable = !mod && !!fp?.id && canEditParts
          const bayStyle = mod
            ? { ...style, ...portOverlayStyle(hex) }
            : { ...style, borderColor: `${hex}59` }
          return (
            <HoverCard key={`${m.name}-${idx}`} openDelay={100} closeDelay={80}>
              <HoverCardTrigger asChild>
                {installable ? (
                  <button
                    type="button"
                    style={bayStyle}
                    title={`${name} - empty, click to install a module`}
                    onClick={() =>
                      fp.id && setInstallBay({ id: fp.id, name: fp.name })
                    }
                    className="absolute cursor-pointer rounded-[2px] border-2 hover:ring-2 hover:ring-primary/40"
                  />
                ) : (
                  <span
                    style={bayStyle}
                    className="absolute rounded-[2px] border-2"
                  />
                )}
              </HoverCardTrigger>
              <HoverCardContent
                side="top"
                className="grid gap-0.5 font-mono text-[11px] whitespace-nowrap"
              >
                <div className="font-semibold">{name}</div>
                <div className="text-muted-foreground">module bay</div>
                {mod ? (
                  <>
                    <div>{mod.module_type.name}</div>
                    {mod.serial_number && (
                      <div className="text-muted-foreground">
                        SN {mod.serial_number}
                      </div>
                    )}
                  </>
                ) : (
                  <div>Empty</div>
                )}
                {installable && (
                  <div className="pt-0.5 font-sans text-[10px] text-muted-foreground">
                    Click to install a module
                  </div>
                )}
              </HoverCardContent>
            </HoverCard>
          )
        }
        // A non-interface port kind (power inlet, console, aux, panel port):
        // resolved through /face-ports/, drawn as a real cage - cabled ports
        // tinted, free ones outlined - with drift ringed like everywhere else.
        if (kind !== "interface") {
          const fp = portByMarker.get(m.name)
          if (!fp?.id)
            return (
              <span
                key={`${m.name}-${idx}`}
                style={style}
                title={`${name} (not on this device)`}
                className="absolute rounded-[2px] border border-dashed border-border/70 bg-background/20"
              />
            )
          const hex = fp.connected ? PORT_NEUTRAL.cabled : PORT_NEUTRAL.free
          // A FREE port is the connect affordance - click opens the cable
          // maker in place with this end already on side A. Cabled markers
          // keep the plain hovercard; unknown marker kinds stay inert.
          const termKind = markerTerminationKind(kind)
          const connectable = !fp.connected && !!termKind && canConnect
          const portStyle = fp.connected
            ? { ...style, ...portOverlayStyle(hex) }
            : {
                ...style,
                borderColor: `${hex}59`,
                ["--port-color" as never]: hex,
              }
          const portClass = cn(
            "absolute rounded-[2px] border-2",
            fp.drift &&
              "ring-2 ring-amber-500 ring-offset-1 ring-offset-background"
          )
          return (
            <HoverCard key={`${m.name}-${idx}`} openDelay={100} closeDelay={80}>
              <HoverCardTrigger asChild>
                {connectable ? (
                  <button
                    type="button"
                    style={portStyle}
                    data-cable-state={fp.cable_state}
                    title={`${fp.name} - free, click to connect a cable`}
                    onClick={() =>
                      fp.id &&
                      setConnect({ id: fp.id, kind: termKind, name: fp.name })
                    }
                    className={cn(
                      portClass,
                      "cursor-pointer hover:ring-2 hover:ring-primary/40"
                    )}
                  />
                ) : (
                  <span
                    style={portStyle}
                    data-cable-state={fp.cable_state}
                    className={portClass}
                  />
                )}
              </HoverCardTrigger>
              <HoverCardContent
                side="top"
                className="grid gap-0.5 font-mono text-[11px] whitespace-nowrap"
              >
                <div className="font-semibold">{fp.name}</div>
                <div className="text-muted-foreground">
                  {[kind.replace(/-/g, " "), fp.type]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                <div>{fp.connected ? "cabled" : "free"}</div>
                {fp.drift && (
                  <div className="font-sans text-[10px] text-amber-600 dark:text-amber-400">
                    drift · {fp.drift}
                  </div>
                )}
                {connectable && (
                  <div className="pt-0.5 font-sans text-[10px] text-muted-foreground">
                    Click to connect a cable
                  </div>
                )}
              </HoverCardContent>
            </HoverCard>
          )
        }
        if (!iface) {
          return (
            <span
              key={`${m.name}-${idx}`}
              style={style}
              title={`${name} (not on this device)`}
              className="absolute rounded-[2px] border border-dashed border-border/70 bg-background/20"
            />
          )
        }
        const state = portState(iface)
        const tint = { ...iface, type: iface.type_display || iface.type }
        const tiered = state !== "free" && state !== "disabled"
        const capability = portCapabilityHex(tint)
        return (
          <HoverCard key={iface.id} openDelay={100} closeDelay={80}>
            <HoverCardTrigger asChild>
              <Link
                to="/interfaces/$id"
                params={{ id: iface.id }}
                data-cable-state={cableState(iface)}
                style={
                  // On a photo: cabled markers get an OPAQUE tier border +
                  // solid-enough fill; idle markers are a VERY faint outline
                  // only (capability-tinted when the type tells us) - no fill,
                  // so the artwork stays the star until a port lights up.
                  tiered
                    ? { ...style, ...portOverlayStyle(portHex(tint)) }
                    : cableState(iface) === "reserved"
                      ? // Directly reserved - amber outline, still no fill.
                        {
                          ...style,
                          borderColor: "#f59e0bb3",
                          backgroundColor: "transparent",
                          ["--port-color" as never]: "#f59e0b",
                        }
                      : {
                          ...style,
                          borderColor: `${capability ?? "#a1a1aa"}59`, // ~35%
                          backgroundColor: "transparent",
                          ["--port-color" as never]: capability ?? "#a1a1aa",
                        }
                }
                className={cn(
                  "absolute rounded-[2px] border-2 transition-opacity hover:opacity-100",
                  state === "disabled" && "border-dashed"
                )}
              >
                {obs && (
                  <span
                    className={cn(
                      "absolute -top-1 -right-1 h-2 w-2 rounded-full ring-1 ring-background",
                      liveDotClass(obs)
                    )}
                    aria-hidden
                  />
                )}
              </Link>
            </HoverCardTrigger>
            <HoverCardContent
              side="top"
              className="grid gap-0.5 font-mono text-[11px] whitespace-nowrap"
            >
              <Link
                to="/interfaces/$id"
                params={{ id: iface.id }}
                className="link font-semibold"
              >
                {iface.name}
              </Link>
              {iface.type_display && <div>{iface.type_display}</div>}
              <div>
                {state === "disabled"
                  ? "disabled"
                  : state === "free"
                    ? "enabled · no cable"
                    : `up${iface.speed ? ` · ${iface.speed}` : ""}`}
              </div>
              {obs && (
                <div className="text-muted-foreground">{liveLine(obs)}</div>
              )}
              {iface.ip_addresses.slice(0, 3).map((ip) => (
                <Link
                  key={ip.id}
                  to="/ips/$id"
                  params={{ id: ip.id }}
                  className="link"
                >
                  {ip.ip_address}
                </Link>
              ))}
            </HoverCardContent>
          </HoverCard>
        )
      })}
      {/* The real part editor, not a copy of it - so changing a disk's status
          from the faceplate is the same write (and the same audit trail) as
          editing it on the Hardware tab. Shares its query key, so the bay
          recolours on save. */}
      {canEditParts && partDialog && (
        <InventoryItemDialog
          deviceId={deviceId!}
          item={partDialog.item}
          initialName={partDialog.name}
          siblings={inventory.data?.results ?? []}
          open
          onOpenChange={(o) => {
            if (!o) setPartDialog(null)
          }}
        />
      )}
      {/* Same deal for module bays: the Modules pane's install dialog, not a
          copy - the write, the toast, and the cache invalidations are shared,
          so the bay marker flips to occupied on save. */}
      {canEditParts && deviceId && installBay && (
        <InstallModuleDialog
          deviceId={deviceId}
          bay={installBay}
          onOpenChange={(o) => {
            if (!o) setInstallBay(null)
          }}
        />
      )}
      {/* In-place cable maker for a clicked free port. Conditionally mounted
          AND keyed: CableForm seeds initialA at mount only, so a stale mount
          would keep the previous port. */}
      <Dialog open={!!connect} onOpenChange={(o) => !o && setConnect(null)}>
        <DialogContent size="2xl" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              Connect a cable from {deviceName ? `${deviceName}:` : ""}
              {connect?.name}
            </DialogTitle>
          </DialogHeader>
          {connect && (
            <CableForm
              key={connect.id}
              initialA={[{ kind: connect.kind, id: connect.id }]}
              onSaved={() => setConnect(null)}
              onCancel={() => setConnect(null)}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** The device type's saved faceplate doc (null = none / auto). Shares the
 * ["device-type", id] cache - parents use this to decide on a Front/Rear
 * toggle without a second fetch. */
export function useSavedFaceplate(
  deviceTypeId?: string | null
): FaceplateDoc | null {
  const dt = useQuery({
    queryKey: ["device-type", deviceTypeId],
    queryFn: () => api<DeviceType>(`/api/device-types/${deviceTypeId}/`),
    enabled: !!deviceTypeId,
    staleTime: 5 * 60_000,
  })
  return dt.data?.faceplate ?? null
}

/** Speed-scale key for the port colors - render once per page, under a
 * faceplate. The colorbar itself lives in `SpeedScale` (shared with the 3D
 * room HUD); this adds the faceplate-only extras (trunk mark, live dot). */
export function FaceplateLegend({
  className,
  observed,
  hardware,
  content,
}: {
  className?: string
  /** Also explain the live SNMP dot. */
  observed?: boolean
  /** The faceplate carries hardware markers → add the status key. Ignored when
   * `content` is given, which knows this for itself. */
  hardware?: boolean
  /** What the panel(s) below actually drew, from `useLegendCollector`. Used
   * ONLY to pick the hardware statuses to list - the speed ramp is static, so
   * the same scale reads the same on every page. */
  content?: LegendContent
}) {
  const hasHardware = content ? content.partStatusIds.size > 0 : !!hardware
  return (
    <div className={cn("grid gap-1.5", className)}>
      <SpeedScale
        live={observed}
        extras={
          <span className="inline-flex items-center gap-1">
            <span className="relative h-2.5 w-3 rounded-[2px] border border-border bg-muted/40">
              <span className="absolute inset-x-0.5 top-0 h-[2px] rounded-b bg-foreground/60" />
            </span>
            trunk
          </span>
        }
      />
      {hasHardware && <HardwareStatusKey statusIds={content?.partStatusIds} />}
      {content && <ModuleBayKey bays={content.bays} />}
      {content && <AirflowKey airflow={content.airflow} />}
    </div>
  )
}
