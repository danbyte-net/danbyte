import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Waypoints } from "lucide-react"

import { api } from "@/lib/api"
import type {
  Cabinet,
  CheckStatus,
  Device,
  FloorPlanLiveState,
  FloorPlanTile,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { StatusBadge } from "@/components/status-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { BarTip } from "@/components/map-toolbar"
import { OpenLink } from "@/components/open-link"
import { PanelRow, PanelSection, PanelShell } from "@/components/map-panel"
import { CabinetElevation } from "@/components/cabinet-elevation"
import {
  CabinetDeviceBodies,
  useCabinetDevices,
} from "@/components/cabinet-devices"
import { tileName } from "@/components/floorplan/floor-canvas"

import { cabinetOuterMm, cabinetState } from "./cabinet-tile"

/** Devices in the order the plate reads: rail by rail as the cabinet sorts
 * them, left to right on each, then the devices off any rail. */
export function plateOrder(devices: Device[], cabinet: Cabinet): Device[] {
  const rank = new Map(cabinet.rails.map((r, i) => [r.id, i]))
  const railOf = (d: Device) =>
    d.din_rail ? (rank.get(d.din_rail.id) ?? rank.size) : rank.size + 1
  return [...devices].sort(
    (a, b) =>
      railOf(a) - railOf(b) ||
      (a.din_offset_mm ?? 0) - (b.din_offset_mm ?? 0) ||
      a.name.localeCompare(b.name)
  )
}

/**
 * What a cabinet tile opens: the floor plan's panel for a DIN-rail cabinet,
 * the cabinet twin of a rack tile's contents sheet. Its facts, its plate
 * drawn as the cabinet page draws it (Images, nothing to click) and its
 * devices, each a link to the device and - with `onTraceDevice` - a way into
 * its end-to-end paths.
 */
export function CabinetPanel({
  tile,
  live,
  onClose,
  onTraceDevice,
}: {
  /** A tile linked to a cabinet. */
  tile: FloorPlanTile
  live?: FloorPlanLiveState["tiles"][string]
  onClose: () => void
  onTraceDevice?: (device: Device) => void
}) {
  const id = tile.linked?.kind === "cabinet" ? tile.linked.id : ""
  const q = useQuery({
    queryKey: ["cabinet", id],
    queryFn: () => api<Cabinet>(`/api/cabinets/${id}/`),
    enabled: !!id,
  })
  const devicesQ = useCabinetDevices(id || null)
  const cabinet = q.data
  const state = cabinetState(live)
  const name = tileName(tile) || cabinet?.name || "Cabinet"

  return (
    <PanelShell
      label="Cabinet"
      title={name}
      onClose={onClose}
      footer={
        id && (
          <OpenLink to="/cabinets/$id" params={{ id }}>
            Open cabinet
          </OpenLink>
        )
      }
    >
      {q.isError ? (
        <QueryError error={q.error} />
      ) : !cabinet ? (
        <Loading className="min-h-24" />
      ) : (
        <CabinetFacts
          cabinet={cabinet}
          check={state?.check ?? null}
          deviceCount={state?.device_count ?? cabinet.device_count}
          railCount={state?.rail_count ?? cabinet.rails.length}
          devicesQ={devicesQ}
          onTraceDevice={onTraceDevice}
        />
      )}
    </PanelShell>
  )
}

function CabinetFacts({
  cabinet,
  check,
  deviceCount,
  railCount,
  devicesQ,
  onTraceDevice,
}: {
  cabinet: Cabinet
  check: CheckStatus | null
  deviceCount: number
  railCount: number
  devicesQ: ReturnType<typeof useCabinetDevices>
  onTraceDevice?: (device: Device) => void
}) {
  const outer = cabinetOuterMm(cabinet)
  const devices = plateOrder(devicesQ.data?.results ?? [], cabinet)
  return (
    <>
      {cabinet.status && (
        <PanelRow label="Status">
          <StatusBadge status={cabinet.status} />
        </PanelRow>
      )}
      {cabinet.role && (
        <PanelRow label="Role">
          <ColorBadge
            name={cabinet.role.name}
            color={cabinet.role.color || undefined}
          />
        </PanelRow>
      )}
      {check && (
        <PanelRow label="Monitoring">
          <CheckStatusBadge status={check} />
        </PanelRow>
      )}
      <PanelRow label="Devices">
        <span className="num">{deviceCount}</span>
      </PanelRow>
      <PanelRow label="Rails">
        <span className="num">{railCount}</span>
      </PanelRow>
      <PanelRow label="Size">
        <span className="num">
          {outer.width}×{outer.height}×{outer.depth} mm
        </span>
      </PanelRow>
      {cabinet.facility_id && (
        <PanelRow label="Facility ID">
          <span className="font-mono">{cabinet.facility_id}</span>
        </PanelRow>
      )}
      <PanelSection label="Plate">
        <CabinetElevation
          width={cabinet.inner_width_mm}
          height={cabinet.inner_height_mm}
          outerWidth={cabinet.outer_width_mm}
          outerHeight={cabinet.outer_height_mm}
          rails={cabinet.rails.map((r) => ({ key: r.id, ...r }))}
          emptyText="No rails yet."
          railLabels={devices.length === 0}
        >
          {devices.length > 0 && (
            <CabinetDeviceBodies
              rails={cabinet.rails}
              devices={devices}
              look="images"
              interactive={false}
            />
          )}
        </CabinetElevation>
      </PanelSection>
      <PanelSection label="Devices">
        {devicesQ.isError ? (
          <QueryError error={devicesQ.error} />
        ) : devicesQ.isLoading ? (
          <Loading className="min-h-16" />
        ) : devices.length === 0 ? (
          <p className="text-muted-foreground">No devices yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {devices.map((d) => (
              <li key={d.id} className="flex items-center gap-2 py-1">
                <span className="num w-10 shrink-0 truncate text-[11px] text-muted-foreground">
                  {d.din_rail?.label ?? "-"}
                </span>
                <Link
                  to="/devices/$id"
                  params={{ id: d.id }}
                  className="link min-w-0 truncate font-medium"
                >
                  {d.name}
                </Link>
                {d.role && (
                  <ColorBadge
                    name={d.role.name}
                    color={d.role.color || undefined}
                    className="h-4 min-w-0 shrink px-1.5 text-[10px]"
                  />
                )}
                {onTraceDevice && (
                  <BarTip tip="Trace">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="ml-auto size-7 shrink-0"
                      aria-label={`Trace ${d.name}`}
                      onClick={() => onTraceDevice(d)}
                    >
                      <Waypoints className="size-3.5" />
                    </Button>
                  </BarTip>
                )}
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </>
  )
}
