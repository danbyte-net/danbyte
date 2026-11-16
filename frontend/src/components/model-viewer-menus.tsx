import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import {
  ArrowUpRight,
  Bookmark,
  Cable as CableIcon,
  PackagePlus,
  Pencil,
  PlugZap,
  Replace,
  Trash2,
  Unplug,
  Waypoints,
} from "lucide-react"

import { api } from "@/lib/api"
import type {
  Cable,
  FacePort,
  Interface,
  ModuleBayRow,
  PortReservationMini,
  TerminationKind,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { cableState } from "@/lib/cable-state"
import { portEndpoint } from "@/lib/cable-runs"
import { hereUrl } from "@/lib/return-url"
import { useMe } from "@/lib/use-me"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { PointerMenu } from "@/components/pointer-menu"
import type { PointerMenuAt } from "@/components/pointer-menu"
import { ConnectCableDialog } from "@/components/connect-cable-dialog"
import type { ConnectFrom } from "@/components/connect-cable-dialog"
import { CableDeleteDialog } from "@/components/cable-delete-dialog"
import { CableTraceDialog } from "@/components/cable-trace-dialog"
import { InterfaceTraceDialog } from "@/components/interface-trace-dialog"
import {
  PortReservationDialog,
  useMarkConnected,
} from "@/components/port-reservation-dialog"
import type { ReservationTarget } from "@/components/port-reservation-dialog"
import {
  InstallModuleDialog,
  RemoveModuleDialog,
} from "@/components/device-modules-pane"

/**
 * The device right-click menus: on a port, the actions its row offers in
 * the device's port tables (connect, trace, disconnect, reserve, mark
 * connected, edit); on a bay, the Modules pane's (install, replace, edit,
 * remove). Each item opens the dialog those surfaces use - one write path,
 * one set of refreshes - and shows only when the user may do it; the
 * server checks again. The 3D viewer, the photo faceplate and the 3D room
 * all open these same menus.
 */

// ─── Ports ───────────────────────────────────────────────────────────────

export type PortAction =
  "open" | "connect" | "trace" | "disconnect" | "reserve" | "mark" | "edit"

export interface PortPerms {
  /** cable.add */
  connect: boolean
  /** cable.delete */
  disconnect: boolean
  /** portreservation.add */
  reserve: boolean
  /** change on the port's own kind (interface.change, …). */
  editPort: boolean
}

export interface MenuItem<TAction extends string> {
  action: TAction
  label: string
  destructive?: boolean
}

/** The RBAC object type for each port kind. */
const PORT_OBJECT: Partial<Record<TerminationKind, string>> = {
  interface: "interface",
  front_port: "frontport",
  rear_port: "rearport",
  console_port: "consoleport",
  console_server_port: "consoleserverport",
  power_port: "powerport",
  power_outlet: "poweroutlet",
  aux_port: "auxport",
}

/** Kinds that carry mark_connected. */
const MARKABLE: ReadonlySet<string> = new Set([
  "interface",
  "front_port",
  "rear_port",
])

/** What a right-click on `port` offers, in order. A marker with no port on
 * the device offers nothing. */
export function portMenuItems(
  port: Pick<
    FacePort,
    "id" | "kind" | "connected" | "cable_id" | "cable_state"
  >,
  perms: PortPerms
): MenuItem<PortAction>[] {
  if (!port.id || !port.kind) return []
  const isIface = port.kind === "interface"
  const items: MenuItem<PortAction>[] = [
    { action: "open", label: isIface ? "Open interface" : "Open on device" },
  ]
  const marked = port.cable_state === "marked"
  const cablePort = portEndpoint(port.kind) !== null
  if (port.connected && port.cable_id) {
    items.push({ action: "trace", label: "Trace cable" })
    if (perms.disconnect)
      items.push({
        action: "disconnect",
        label: "Disconnect…",
        destructive: true,
      })
  } else if (!port.connected && cablePort) {
    if (perms.connect && !marked)
      items.push({ action: "connect", label: "Connect cable…" })
    const held = port.cable_state === "reserved"
    if (!marked && (perms.reserve || held))
      items.push({
        action: "reserve",
        label: held ? "Reservation…" : "Reserve…",
      })
    if (perms.editPort && MARKABLE.has(port.kind))
      items.push({
        action: "mark",
        label: marked ? "Clear mark" : "Mark connected",
      })
  }
  if (isIface && perms.editPort) items.push({ action: "edit", label: "Edit" })
  return items
}

export function usePortPerms(kind: TerminationKind | null): PortPerms {
  const { canDo } = useMe()
  const obj = kind ? PORT_OBJECT[kind] : undefined
  return {
    connect: canDo("cable", "add"),
    disconnect: canDo("cable", "delete"),
    reserve: canDo("portreservation", "add"),
    editPort: !!obj && canDo(obj, "change"),
  }
}

// ─── Bays ────────────────────────────────────────────────────────────────

export type BayAction = "open" | "install" | "replace" | "edit" | "remove"

export interface BayPerms {
  /** module.add */
  install: boolean
  /** module.change */
  change: boolean
  /** module.delete */
  remove: boolean
}

/** What a right-click on a bay offers: an installed module's actions, or
 * Install on an empty bay. */
export function bayMenuItems(
  bay: Pick<ModuleBayRow, "module"> | null,
  perms: BayPerms
): MenuItem<BayAction>[] {
  if (!bay) return []
  if (!bay.module)
    return perms.install
      ? [{ action: "install", label: "Install module…" }]
      : []
  const items: MenuItem<BayAction>[] = [
    { action: "open", label: "Open module type" },
  ]
  if (perms.change)
    items.push(
      { action: "edit", label: "Edit…" },
      { action: "replace", label: "Replace…" }
    )
  if (perms.remove)
    items.push({
      action: "remove",
      label: "Remove from bay…",
      destructive: true,
    })
  return items
}

export function useBayPerms(): BayPerms {
  const { canDo } = useMe()
  return {
    install: canDo("module", "add"),
    change: canDo("module", "change"),
    remove: canDo("module", "delete"),
  }
}

const baysQuery = (deviceId: string) => ({
  queryKey: ["device-module-bays", deviceId],
  queryFn: () => apiAll<ModuleBayRow>(`/api/module-bays/?device=${deviceId}`),
})

/** The device's module bays - the Modules pane's request and cache, so an
 * install from either surface refreshes both. */
export function useDeviceBays(deviceId: string | null | undefined) {
  return useQuery({
    ...baysQuery(deviceId ?? ""),
    enabled: !!deviceId,
  })
}

/** An interface row as the port menu reads it: the face-ports shape, from
 * the interface list a faceplate already holds. */
export function interfacePort(i: Interface): FacePort {
  return {
    marker: i.name,
    name: i.name,
    kind: "interface",
    id: i.id,
    connected: !!i.cable,
    cable_state: cableState(i),
    cable_id: i.cable?.id ?? null,
    enabled: i.enabled,
    speed: i.speed,
    type: i.type,
    status: null,
    module: null,
    drift: null,
  }
}

const PORT_ICON: Record<PortAction, React.ReactNode> = {
  open: <ArrowUpRight />,
  connect: <CableIcon />,
  trace: <Waypoints />,
  disconnect: <Unplug />,
  reserve: <Bookmark />,
  mark: <PlugZap />,
  edit: <Pencil />,
}

const BAY_ICON: Record<BayAction, React.ReactNode> = {
  open: <ArrowUpRight />,
  install: <PackagePlus />,
  edit: <Pencil />,
  replace: <Replace />,
  remove: <Trash2 />,
}

export type PortMenuAt = PointerMenuAt & { port: FacePort }
export type BayMenuAt = PointerMenuAt & { bay: string }

/** Open a port: its interface page, else the device's Components tab. */
export function useOpenPort(deviceId: string) {
  const navigate = useNavigate()
  return (port: Pick<FacePort, "id" | "kind">) => {
    if (!port.id) return
    if (port.kind === "interface")
      void navigate({ to: "/interfaces/$id", params: { id: port.id } })
    else
      void navigate({
        to: "/devices/$id",
        params: { id: deviceId },
        search: { tab: "components" },
      })
  }
}

/**
 * The menus and the dialogs they open, beside the viewer's canvas. The
 * caller sets `portMenu` / `bayMenu` on a right-click.
 */
export function ModelViewerMenus({
  deviceId,
  deviceName,
  manufacturerId,
  portMenu,
  bayMenu,
  onClose,
  onChanged,
  onDialog,
}: {
  deviceId: string
  deviceName?: string
  /** The chassis' manufacturer: its module types come first. */
  manufacturerId?: string | null
  portMenu: PortMenuAt | null
  bayMenu: BayMenuAt | null
  onClose: () => void
  /** Extra refresh work for the host after a cable or module write (the
   * 3D room's scene payload) - the port, module and LED caches are
   * refreshed here already. */
  onChanged?: () => void
  /** One of the menus' dialogs opened or closed - a host whose keys act on
   * its canvas holds them while one is up. */
  onDialog?: (open: boolean) => void
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  // A cable or a module changes what the device's LEDs show.
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ["device-leds"] })
    onChanged?.()
  }
  const openPort = useOpenPort(deviceId)
  const portPerms = usePortPerms(portMenu?.port.kind ?? null)
  const bayPerms = useBayPerms()
  const bays = useDeviceBays(deviceId)

  const [connect, setConnect] = useState<ConnectFrom | null>(null)
  const [trace, setTrace] = useState<FacePort | null>(null)
  const [disconnect, setDisconnect] = useState<string | null>(null)
  const [reserve, setReserve] = useState<ReservationTarget | null>(null)
  const [bayDialog, setBayDialog] = useState<{
    row: ModuleBayRow
    mode: "install" | "replace" | "edit"
  } | null>(null)
  const [removing, setRemoving] = useState<ModuleBayRow | null>(null)
  const dialogOpen =
    !!connect ||
    !!trace ||
    !!disconnect ||
    !!reserve ||
    !!bayDialog ||
    !!removing
  useEffect(() => onDialog?.(dialogOpen), [dialogOpen, onDialog])

  const menuPort = portMenu?.port ?? null
  const endpoint = menuPort?.kind ? portEndpoint(menuPort.kind) : null
  const mark = useMarkConnected(
    `/api/${endpoint ?? "interfaces"}/`,
    menuPort?.id ?? "",
    menuPort?.cable_state === "marked"
  )
  const cable = useQuery({
    queryKey: ["cable", disconnect],
    queryFn: () => api<Cable>(`/api/cables/${disconnect}/`),
    enabled: !!disconnect,
    staleTime: 10_000,
  })

  const runPort = async (action: PortAction, port: FacePort) => {
    if (!port.id || !port.kind) return
    switch (action) {
      case "open":
        return openPort(port)
      case "connect":
        return setConnect({ id: port.id, kind: port.kind, name: port.name })
      case "trace":
        return setTrace(port)
      case "disconnect":
        return port.cable_id && setDisconnect(port.cable_id)
      case "mark":
        return mark.mutate()
      case "edit":
        return void navigate({
          to: "/interfaces/$id/edit",
          params: { id: port.id },
          search: { ret: hereUrl() },
        })
      case "reserve": {
        let reservation: PortReservationMini | null = null
        // A held port's hold, to show and release.
        if (port.cable_state === "reserved" && endpoint) {
          const row = await api<{ reservation?: PortReservationMini | null }>(
            `/api/${endpoint}/${port.id}/`
          ).catch(() => null)
          reservation = row?.reservation ?? null
        }
        return setReserve({
          kind: port.kind,
          id: port.id,
          name: port.name,
          reservation,
        })
      }
    }
  }

  const rowOf = (name: string) =>
    bays.data?.results.find((b) => b.name === name) ?? null
  const runBay = (action: BayAction, row: ModuleBayRow) => {
    switch (action) {
      case "open":
        return (
          row.module &&
          void navigate({
            to: "/module-types/$id",
            params: { id: row.module.module_type.id },
          })
        )
      case "remove":
        return setRemoving(row)
      default:
        return setBayDialog({ row, mode: action })
    }
  }

  return (
    <>
      <PointerMenu menu={portMenu} onClose={onClose} label="Port">
        {(m) =>
          portMenuItems(m.port, portPerms).map((it) => (
            <DropdownMenuItem
              key={it.action}
              variant={it.destructive ? "destructive" : "default"}
              onSelect={() => void runPort(it.action, m.port)}
            >
              {PORT_ICON[it.action]}
              {it.label}
            </DropdownMenuItem>
          ))
        }
      </PointerMenu>
      <PointerMenu menu={bayMenu} onClose={onClose} label="Module bay">
        {(m) => {
          const row = rowOf(m.bay)
          return bayMenuItems(row, bayPerms).map((it) => (
            <DropdownMenuItem
              key={it.action}
              variant={it.destructive ? "destructive" : "default"}
              onSelect={() => row && runBay(it.action, row)}
            >
              {BAY_ICON[it.action]}
              {it.label}
            </DropdownMenuItem>
          ))
        }}
      </PointerMenu>

      <ConnectCableDialog
        from={connect}
        deviceName={deviceName}
        onClose={() => {
          // Saved or cancelled: the form does not say which.
          if (connect) changed()
          setConnect(null)
        }}
      />
      <InterfaceTraceDialog
        target={
          trace?.kind === "interface" && trace.id
            ? { id: trace.id, name: trace.name }
            : null
        }
        onOpenChange={(o) => !o && setTrace(null)}
      />
      <CableTraceDialog
        target={
          trace && trace.kind !== "interface" && trace.cable_id
            ? { id: trace.cable_id, label: trace.name }
            : null
        }
        onOpenChange={(o) => !o && setTrace(null)}
      />
      {disconnect && (
        <CableDeleteDialog
          cable={cable.data ?? null}
          onOpenChange={(o) => !o && setDisconnect(null)}
          onDeleted={changed}
        />
      )}
      <PortReservationDialog
        target={reserve}
        onClose={() => setReserve(null)}
      />
      <InstallModuleDialog
        deviceId={deviceId}
        bay={bayDialog?.row ?? null}
        mode={bayDialog?.mode}
        seated={bayDialog?.row.module ?? null}
        manufacturerId={manufacturerId}
        onOpenChange={(o) => !o && setBayDialog(null)}
        onInstalled={changed}
      />
      <RemoveModuleDialog
        deviceId={deviceId}
        target={
          removing?.module
            ? {
                moduleId: removing.module.id,
                typeName: removing.module.module_type.name,
                bayName: removing.name,
              }
            : null
        }
        onOpenChange={(o) => !o && setRemoving(null)}
        onRemoved={changed}
      />
    </>
  )
}

// ─── Hosts without a fixed device ────────────────────────────────────────

/** The device a menu is for. */
export interface MenuDevice {
  deviceId: string
  deviceName?: string
  manufacturerId?: string | null
}

/** What was right-clicked on a device: one of its ports, or a module bay
 * by name. */
export type DeviceMenuTarget = { port: FacePort } | { bay: string }

/** Does a right-click on this port open anything? Every resolved port
 * offers Open; a marker with no port behind it offers nothing. */
export const portHasMenu = (port: Pick<FacePort, "id" | "kind">) =>
  !!port.id && !!port.kind

/** The bay's row, from the shared cache or fetched into it. */
async function bayRow(
  qc: QueryClient,
  deviceId: string,
  bay: string
): Promise<ModuleBayRow | null> {
  const rows = await qc
    .fetchQuery({ ...baysQuery(deviceId), staleTime: 10_000 })
    .catch(() => null)
  return rows?.results.find((b) => b.name === bay) ?? null
}

/** A right-click a surface reports up to its menus' host. */
export type OnDeviceMenu = (
  device: MenuDevice,
  target: DeviceMenuTarget,
  at: PointerMenuAt
) => void

/** The hook's opener: true when a menu opened (one with nothing in it
 * never does). */
export type OpenDeviceMenu = (
  device: MenuDevice,
  target: DeviceMenuTarget,
  at: PointerMenuAt
) => Promise<boolean>

/**
 * The same menus for a surface that shows many devices - a rack's photo
 * faces, the 3D room - or one that may never be right-clicked: nothing
 * mounts (no bay request, no dialogs) until the first menu opens, and the
 * dialogs then stay with the device last right-clicked.
 */
export function useDeviceMenus({ onChanged }: { onChanged?: () => void } = {}) {
  const qc = useQueryClient()
  const bayPerms = useBayPerms()
  const permsRef = useRef(bayPerms)
  permsRef.current = bayPerms
  const [device, setDevice] = useState<MenuDevice | null>(null)
  const [portMenu, setPortMenu] = useState<PortMenuAt | null>(null)
  const [bayMenu, setBayMenu] = useState<BayMenuAt | null>(null)
  const [dialog, setDialog] = useState(false)

  const open = useCallback<OpenDeviceMenu>(
    async (dev, target, at) => {
      if ("port" in target) {
        if (!portHasMenu(target.port)) return false
        setDevice(dev)
        setBayMenu(null)
        setPortMenu({ x: at.x, y: at.y, port: target.port })
        return true
      }
      const row = await bayRow(qc, dev.deviceId, target.bay)
      if (bayMenuItems(row, permsRef.current).length === 0) return false
      setDevice(dev)
      setPortMenu(null)
      setBayMenu({ x: at.x, y: at.y, bay: target.bay })
      return true
    },
    [qc]
  )

  const menus = device ? (
    <ModelViewerMenus
      deviceId={device.deviceId}
      deviceName={device.deviceName}
      manufacturerId={device.manufacturerId}
      portMenu={portMenu}
      bayMenu={bayMenu}
      onChanged={onChanged}
      onDialog={setDialog}
      onClose={() => {
        setPortMenu(null)
        setBayMenu(null)
      }}
    />
  ) : null
  /** A menu or one of its dialogs is up. */
  const isOpen = !!portMenu || !!bayMenu || dialog
  return { open, menus, isOpen }
}
