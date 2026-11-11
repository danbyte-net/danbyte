import type { Device, VirtualMachine } from "@/lib/api"

/**
 * What the Connect menu and the in-browser terminal need to know about a host.
 * A device and a VM take the same path; `kind` is also the RBAC slug whose
 * `connect` verb gates both.
 */
export interface ConnectHost {
  kind: "device" | "virtualmachine"
  id: string
  name: string
  /** The recorded address, mask stripped, or "" when the host has none. */
  address: string
}

/** Strip a CIDR mask ("10.0.0.1/24" → "10.0.0.1") before it lands in a URL. */
function stripMask(ip: string): string {
  return ip.split("/")[0]
}

/** A device's connect target: primary IP, then OOB IP. */
export function deviceConnectHost(device: Device): ConnectHost {
  const ip = device.primary_ip?.ip_address || device.oob_ip?.ip_address
  return {
    kind: "device",
    id: device.id,
    name: device.name,
    address: ip ? stripMask(ip) : "",
  }
}

/** A VM's connect target: its primary IP (a VM has no OOB address). */
export function vmConnectHost(vm: VirtualMachine): ConnectHost {
  const ip = vm.primary_ip?.ip_address
  return {
    kind: "virtualmachine",
    id: vm.id,
    name: vm.name,
    address: ip ? stripMask(ip) : "",
  }
}

/** The query parameter the credentials and connect-protocol lists filter on. */
export function hostFilterParam(host: ConnectHost): string {
  return host.kind === "device" ? "device" : "virtual_machine"
}

/** The terminal's WebSocket path for this host. */
export function terminalSocketPath(host: ConnectHost): string {
  return host.kind === "device"
    ? `/ws/ssh/${host.id}/`
    : `/ws/ssh/vm/${host.id}/`
}

/** "device" / "virtual machine", for user-facing copy. */
export function hostNoun(host: ConnectHost): string {
  return host.kind === "device" ? "device" : "virtual machine"
}
