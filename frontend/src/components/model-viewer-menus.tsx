import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
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
  ModuleBayRow,
  PortReservationMini,
  TerminationKind,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
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
 * The 3D model viewer's right-click menus: on a mapped port, the actions
 * its row offers in the device's port tables (connect, trace, disconnect,
 * reserve, mark connected, edit); on a bay, the Modules pane's (install,
 * replace, edit, remove). Each item opens the dialog those surfaces use -
 * one write path, one set of refreshes - and shows only when the user may
 * do it; the server checks again.
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

/** The device's module bays - the Modules pane's request and cache, so an
 * install from either surface refreshes both. */
export function useDeviceBays(deviceId: string | null | undefined) {
  return useQuery({
    queryKey: ["device-module-bays", deviceId],
    queryFn: () => apiAll<ModuleBayRow>(`/api/module-bays/?device=${deviceId}`),
    enabled: !!deviceId,
  })
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
}: {
  deviceId: string
  deviceName?: string
  /** The chassis' manufacturer: its module types come first. */
  manufacturerId?: string | null
  portMenu: PortMenuAt | null
  bayMenu: BayMenuAt | null
  onClose: () => void
}) {
  const navigate = useNavigate()
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
        onClose={() => setConnect(null)}
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
      />
    </>
  )
}
