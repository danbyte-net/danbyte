import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import type {
  DeviceMacs,
  Interface,
  InterfaceMacRow,
  InterfaceWritePayload,
  MacLocationRef,
  MacRefreshRun,
  MacRefreshStart,
  MacTableMeta,
  MacVendor,
  ObservedIpSource,
  ObservedName,
  PortMacs,
  UplinkReason,
  UplinkState,
} from "@/lib/api"

// MAC tracking (#284) in the UI: the device and port queries, Refresh MACs,
// and the small pure helpers the cells, tables and forms share.

/** `member` = this device's own ports (Components); `observed` = the stack
 * owner's whole observation (the SNMP tab, which shows the owner's table). */
export type MacView = "member" | "observed"

/** Where a port's full list comes from when its cell only holds a few. */
export interface MacSource {
  deviceId: string
  view: MacView
}

/** `GET /api/monitoring/devices/<id>/macs/` - learned MACs per port, up to
 * the tenant's "MACs shown per port" each. */
export function useDeviceMacs(
  deviceId: string,
  view: MacView,
  opts?: { enabled?: boolean }
) {
  return useQuery({
    queryKey: ["device-macs", deviceId, view],
    queryFn: () =>
      api<DeviceMacs>(`/api/monitoring/devices/${deviceId}/macs/?view=${view}`),
    enabled: opts?.enabled ?? true,
  })
}

/** The ports of a device that reports a MAC table, by Danbyte interface id -
 * what an interface table's Learned MACs column reads. Undefined for a
 * device without one, so the column stays away. */
export function learnedByInterface(
  macs: DeviceMacs | undefined,
  source: MacSource
): { ports: Map<string, PortMacs>; source: MacSource } | undefined {
  if (!macs || !reportsMacTable(macs.meta, macs.read_at)) return undefined
  const ports = new Map<string, PortMacs>()
  for (const p of macs.ports) if (p.interface_id) ports.set(p.interface_id, p)
  return { ports, source }
}

/** Every MAC of every port (`limit=0`) - what "+N more" lists. Fetched only
 * once a popover asks for it. */
export function useAllDeviceMacs(source: MacSource, enabled: boolean) {
  return useQuery({
    queryKey: ["device-macs", source.deviceId, source.view, "all"],
    queryFn: () =>
      api<DeviceMacs>(
        `/api/monitoring/devices/${source.deviceId}/macs/?view=${source.view}&limit=0`
      ),
    enabled,
  })
}

/** The table sources a bridging device's read can come from. `none` (no
 * forwarding table) and `stack` (a member - its owner records the table) are
 * not one. */
const TABLE_SOURCES = new Set(["qbridge", "bridge", "bridge-vlan", "legacy"])

function metaSource(
  meta: MacTableMeta | Record<string, never> | null | undefined
): string {
  return meta && "source" in meta ? meta.source : ""
}

/** Does this device report a MAC table? Then its port lists show learned MACs
 * instead of the ports' own hardware addresses. */
export function reportsMacTable(
  meta: MacTableMeta | Record<string, never> | null | undefined,
  readAt?: string | null
): boolean {
  return !!readAt || TABLE_SOURCES.has(metaSource(meta))
}

/** The last read stopped early (a time budget, the row cap, a quick read
 * that skipped the per-VLAN tables): it added what it saw, closed nothing. */
export function isPartialRead(
  meta: MacTableMeta | Record<string, never> | null | undefined
): meta is MacTableMeta {
  return (
    !!meta &&
    "complete" in meta &&
    TABLE_SOURCES.has(metaSource(meta)) &&
    !meta.complete
  )
}

// ─── Uplink: Automatic / Always / Never ─────────────────────────────────────

export type UplinkMode = UplinkState["mode"]

export const UPLINK_OPTIONS: { value: UplinkMode; label: string }[] = [
  { value: "auto", label: "Automatic" },
  { value: "always", label: "Always" },
  { value: "never", label: "Never" },
]

/** The interface's Uplink setting - two API fields, one choice. */
export function uplinkModeOf(
  i: Pick<Interface, "is_uplink" | "never_uplink">
): UplinkMode {
  if (i.is_uplink) return "always"
  return i.never_uplink ? "never" : "auto"
}

/** The two fields a choice writes. Both are always sent: setting one while
 * the other is still on is refused. */
export function uplinkFields(
  mode: UplinkMode
): Required<Pick<InterfaceWritePayload, "is_uplink" | "never_uplink">> {
  return { is_uplink: mode === "always", never_uplink: mode === "never" }
}

/** A reason in its shortest form - "LLDP sw-core-01", "7 MACs, above 4". */
export function uplinkWhy(r: UplinkReason): string {
  return r.code === "lldp" && r.neighbor ? `LLDP ${r.neighbor}` : r.text
}

// ─── Labels ─────────────────────────────────────────────────────────────────

const HOST_NAME_SOURCES = new Set<ObservedName["source"]>([
  "dns",
  "dns_record",
  "dhcp_lease",
  "dhcp_reservation",
])

/** A DNS name to its host part (`pc-044.corp.local` → `pc-044`); a known
 * object's label ("srv-db-01 · eth0") stays whole. */
export function shortName(
  name: string,
  source: ObservedName["source"] | null
): string {
  if (!source || !HOST_NAME_SOURCES.has(source)) return name
  const dot = name.indexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

/** The muted label beside a MAC in a cell: name · IP, else the vendor. */
export function macLabel(m: {
  name: string | null
  name_source: ObservedName["source"] | null
  ips: { ip: string }[]
  vendor: MacVendor | null
}): string {
  const parts = [
    m.name ? shortName(m.name, m.name_source) : "",
    m.ips[0]?.ip ?? "",
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : (m.vendor?.name ?? "")
}

export const NAME_SOURCE_LABEL: Record<ObservedName["source"], string> = {
  interface: "Interface",
  vminterface: "VM interface",
  macaddress: "MAC object",
  dns: "Reverse DNS",
  dns_record: "DNS record",
  dhcp_lease: "DHCP lease",
  dhcp_reservation: "DHCP reservation",
}

/** Where an IP was learned: "ARP on sw-core-01", "DHCP lease", … */
export function ipSourceLabel(s: ObservedIpSource): string {
  switch (s.kind) {
    case "arp": {
      const owner = s.device ?? s.vm
      return owner ? `ARP on ${owner.name}` : "ARP"
    }
    case "dhcp_lease":
      return "DHCP lease"
    case "dhcp_reservation":
      return "DHCP reservation"
    case "ipaddress":
      return "Paired"
  }
}

/** A port's rows (one per VLAN) as one line per MAC - its VLANs merged, the
 * first sighting kept. */
export interface PortMacLine {
  mac: string
  vendor: MacVendor | null
  vlans: number[]
  ips: { ip: string; id: string | null }[]
  name: string | null
  name_source: ObservedName["source"] | null
  first_seen: string
  here: boolean
  location: MacLocationRef | null
}

export function linesByMac(rows: InterfaceMacRow[]): PortMacLine[] {
  const out = new Map<string, PortMacLine>()
  for (const r of rows) {
    const cur = out.get(r.mac)
    if (!cur) {
      out.set(r.mac, {
        mac: r.mac,
        vendor: r.vendor,
        vlans: r.vlan == null ? [] : [r.vlan],
        ips: r.ips,
        name: r.name,
        name_source: r.name_source,
        first_seen: r.first_seen,
        here: r.here,
        location: r.location,
      })
      continue
    }
    if (r.vlan != null && !cur.vlans.includes(r.vlan)) cur.vlans.push(r.vlan)
    if (r.first_seen < cur.first_seen) cur.first_seen = r.first_seen
  }
  for (const l of out.values()) l.vlans.sort((a, b) => a - b)
  return [...out.values()]
}

// ─── Search ─────────────────────────────────────────────────────────────────

// The notations the search takes for a whole MAC - the server's own rule
// (api/search_views.py): 3c:52:82:aa:10:44, 3C-52-82-AA-10-44,
// 3c52.82aa.1044, 3c5282-aa1044, 3c5282aa1044.
const MAC_QUERY =
  /^(?:[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}|[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}|[0-9a-f]{6}-[0-9a-f]{6}|[0-9a-f]{12})$/i

/** `aa:bb:cc:dd:ee:ff` for a query that is one whole MAC, else null. */
export function macQuery(q: string): string | null {
  const t = q.trim()
  if (!MAC_QUERY.test(t)) return null
  const hex = t.replace(/[^0-9a-f]/gi, "").toLowerCase()
  return (hex.match(/../g) ?? []).join(":")
}

// ─── Refresh MACs ───────────────────────────────────────────────────────────

const RUN_POLL_MS = 1500
/** The server's single-flight lock lives 15 minutes; a run is over by then. */
const RUN_GIVE_UP_MS = 15 * 60_000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const fmt = (n: number | undefined) => (n ?? 0).toLocaleString()

interface RefreshOutcome {
  status: MacRefreshRun["status"] | "outpost" | "timeout"
  macs?: number
  ports?: number
  complete?: boolean | null
  error?: string
  detail?: string
}

function announce(o: RefreshOutcome) {
  const counts = `${fmt(o.macs)} MACs on ${fmt(o.ports)} ports`
  switch (o.status) {
    case "done":
      if (o.complete === false)
        toast.warning(`Partial MAC table · ${counts}`, {
          description: o.error || undefined,
        })
      else toast.success(`MAC table read · ${counts}`)
      return
    case "outpost":
      toast.info(o.detail || "Queued on the site's Outpost")
      return
    case "timeout":
      toast.info("Still refreshing - the table updates when it is done")
      return
    case "unreachable":
      toast.error(o.error || "Device did not respond to SNMP")
      return
    case "unknown":
      toast.error("Refresh MACs: the run was lost")
      return
    default:
      toast.error(o.error || "Refresh MACs failed")
  }
}

/**
 * Refresh MACs for a device: start the background read, follow its run until
 * it is done, then say how it went and reload what shows MACs. Every button
 * for the same device shares the pending state, so the SNMP tab and the
 * Components toolbar both read `Refreshing…` while one runs.
 */
export function useMacRefresh(deviceId: string) {
  const qc = useQueryClient()
  const mutationKey = ["mac-refresh", deviceId]
  const pending = useIsMutating({ mutationKey }) > 0

  const reload = () => {
    for (const key of [
      ["device-snmp", deviceId],
      ["device-snmp-util", deviceId],
      ["device-snmp-drift", deviceId],
      ["device-macs"],
      ["interface-macs"],
      ["mac-sightings"],
      ["mac"],
    ])
      void qc.invalidateQueries({ queryKey: key })
  }

  const m = useMutation({
    mutationKey,
    mutationFn: async (): Promise<RefreshOutcome> => {
      const start = await api<MacRefreshStart>(
        `/api/monitoring/devices/${deviceId}/mac-refresh/`,
        { method: "POST", body: JSON.stringify({}) }
      )
      if ("queued_on_outpost" in start)
        return { status: "outpost", detail: start.detail }
      if (!start.queued) return start
      const until = Date.now() + RUN_GIVE_UP_MS
      for (;;) {
        await sleep(RUN_POLL_MS)
        const run = await api<MacRefreshRun>(
          `/api/monitoring/mac-refresh/${start.run_id}/`
        )
        if (run.done) return run
        if (Date.now() > until) return { status: "timeout" }
      }
    },
    onSuccess: (outcome) => {
      announce(outcome)
      reload()
      // An Outpost reads on its next pass, not now.
      if (outcome.status === "outpost") setTimeout(reload, 30_000)
    },
    onError: (e) => apiErrorToast(e),
  })

  return { refresh: () => m.mutate(), pending: pending || m.isPending }
}
