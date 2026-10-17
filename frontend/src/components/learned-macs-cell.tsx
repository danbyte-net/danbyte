import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { ArrowRight, ListRestart } from "lucide-react"

import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { dash } from "@/components/cells/dash"
import { TimeCell } from "@/components/cells/time-ago"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { SimpleTable } from "@/components/ui/simple-table"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  linesByMac,
  macLabel,
  useAllDeviceMacs,
  useMacRefresh,
} from "@/lib/mac-tracking"
import type {
  InterfaceMacs,
  LearnedMac,
  MacListLocation,
  MacLocationRef,
  PortMacs,
  UplinkState,
} from "@/lib/api"
import type { MacSource, PortMacLine } from "@/lib/mac-tracking"
import type { SimpleColumn } from "@/components/ui/simple-table"

/** Rows an uplink's count lists before pointing at the MACs tab. */
const UPLINK_LIST_LIMIT = 100

/**
 * The Learned MACs cell (#284), shared by the SNMP tab's interface table and
 * the device's Components → Interfaces table: the port's MACs one per line
 * (as many as "MACs shown per port"), each with a muted name · IP, then
 * `+N more` for the rest. An uplink shows its badge and a count instead -
 * clicking the count lists what it sees and where each MAC really sits.
 */
export function LearnedMacsCell({
  port,
  source,
}: {
  port?: PortMacs
  source: MacSource
}) {
  if (!port) return dash
  if (port.uplink.is) return <UplinkMacs port={port} />
  if (port.count === 0) return dash
  const more = port.count - port.macs.length
  return (
    <div className="flex flex-col gap-0.5">
      {port.macs.map((m) => (
        <MacLine key={m.mac} m={m} />
      ))}
      {more > 0 && <MoreMacs port={port} more={more} source={source} />}
    </div>
  )
}

function MacLine({ m }: { m: LearnedMac }) {
  return (
    <span className="flex items-baseline gap-2 whitespace-nowrap">
      <MacLink mac={m.mac} />
      {!m.here && m.location ? (
        // Seen here, but it sits on another port.
        <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
          <ArrowRight className="h-3 w-3 shrink-0 self-center" />
          <LocationRef loc={m.location} size="text-[11px]" />
        </span>
      ) : (
        <span className="text-[11px] text-muted-foreground">{macLabel(m)}</span>
      )}
    </span>
  )
}

export function MacLink({
  mac,
  className,
}: {
  mac: string
  className?: string
}) {
  return (
    <Link
      to="/macs/$mac"
      params={{ mac }}
      className={cn("link font-mono text-xs", className)}
    >
      {mac}
    </Link>
  )
}

function PopoverHeading({ name, count }: { name: string; count: number }) {
  return (
    <div className="flex items-baseline gap-2 px-0.5 text-xs">
      <span className="font-mono font-medium">{name}</span>
      <span className="num text-muted-foreground">
        {count.toLocaleString()} {count === 1 ? "MAC" : "MACs"}
      </span>
    </div>
  )
}

const POPOVER_CLS = "w-auto max-w-[min(48rem,calc(100vw-2rem))] gap-2 p-3"

/** `+N more`: the whole list of an access port. The cell holds only the
 * first few, so the full table is fetched when the popover opens. */
function MoreMacs({
  port,
  more,
  source,
}: {
  port: PortMacs
  more: number
  source: MacSource
}) {
  const [open, setOpen] = useState(false)
  const all = useAllDeviceMacs(source, open)
  const full = all.data?.ports.find((p) => p.port_key === port.port_key)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="link w-fit text-left text-[11px] text-muted-foreground"
        >
          +{more} more
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={POPOVER_CLS}>
        <PopoverHeading
          name={port.interface_name ?? port.port_name}
          count={port.count}
        />
        {all.isLoading ? (
          <Loading className="min-h-16" />
        ) : all.isError ? (
          <QueryError error={all.error} />
        ) : (
          <div className="max-h-80 overflow-auto">
            <SimpleTable
              columns={PORT_MAC_COLUMNS}
              data={full?.macs ?? port.macs}
              getRowKey={(m) => m.mac}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

const PORT_MAC_COLUMNS: SimpleColumn<LearnedMac>[] = [
  { id: "mac", header: "MAC", cell: (m) => <MacLink mac={m.mac} /> },
  { id: "vlan", header: "VLAN", cell: (m) => <VlanList vlans={m.vlans} /> },
  { id: "ip", header: "IP", cell: (m) => <IpList ips={m.ips} /> },
  {
    id: "name",
    header: "Name",
    cell: (m) => (m.name ? <span className="text-xs">{m.name}</span> : dash),
  },
  {
    id: "first",
    header: "First seen",
    cell: (m) => <TimeCell iso={m.first_seen} />,
  },
]

export function VlanList({ vlans }: { vlans: number[] }) {
  if (!vlans.length) return dash
  return <span className="num text-xs">{vlans.join(", ")}</span>
}

export function IpList({ ips }: { ips: { ip: string; id: string | null }[] }) {
  if (!ips.length) return dash
  return (
    <span className="flex flex-wrap gap-x-2">
      {ips.map((ip) =>
        ip.id ? (
          <Link
            key={ip.ip}
            to="/ips/$id"
            params={{ id: ip.id }}
            className="link font-mono text-xs"
          >
            {ip.ip}
          </Link>
        ) : (
          <span key={ip.ip} className="font-mono text-xs">
            {ip.ip}
          </span>
        )
      )}
    </span>
  )
}

/** An uplink: its badge, with the reasons in the tooltip, and its count. */
function UplinkMacs({ port }: { port: PortMacs }) {
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">
      <UplinkBadge uplink={port.uplink} label="Uplink" />
      {port.interface_id ? (
        <UplinkCount
          interfaceId={port.interface_id}
          name={port.interface_name ?? port.port_name}
          count={port.count}
        />
      ) : (
        <span className="num text-xs">
          {port.count.toLocaleString()} {port.count === 1 ? "MAC" : "MACs"}
        </span>
      )}
    </span>
  )
}

/** The count of an uplink; clicking it lists the MACs seen through the port
 * and where each one sits. */
function UplinkCount({
  interfaceId,
  name,
  count,
}: {
  interfaceId: string
  name: string
  count: number
}) {
  const [open, setOpen] = useState(false)
  const q = useQuery({
    queryKey: ["interface-macs", interfaceId, "present", "popover"],
    queryFn: () =>
      api<InterfaceMacs>(
        `/api/monitoring/interfaces/${interfaceId}/macs/?state=present&limit=${UPLINK_LIST_LIMIT}`
      ),
    enabled: open,
  })
  const lines = q.data ? linesByMac(q.data.results) : []
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className="link num text-xs">
          {count.toLocaleString()} {count === 1 ? "MAC" : "MACs"}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className={POPOVER_CLS}>
        <PopoverHeading name={name} count={count} />
        {q.isLoading ? (
          <Loading className="min-h-16" />
        ) : q.isError ? (
          <QueryError error={q.error} />
        ) : (
          <div className="max-h-80 overflow-auto">
            <SimpleTable
              columns={THROUGH_COLUMNS}
              data={lines}
              getRowKey={(m) => m.mac}
            />
          </div>
        )}
        <Link
          to="/interfaces/$id"
          params={{ id: interfaceId }}
          search={{ tab: "macs" }}
          className="link w-fit px-0.5 text-xs text-muted-foreground"
        >
          Open the MACs tab
        </Link>
      </PopoverContent>
    </Popover>
  )
}

const THROUGH_COLUMNS: SimpleColumn<PortMacLine>[] = [
  { id: "mac", header: "MAC", cell: (m) => <MacLink mac={m.mac} /> },
  { id: "vlan", header: "VLAN", cell: (m) => <VlanList vlans={m.vlans} /> },
  {
    id: "name",
    header: "Name",
    cell: (m) => (m.name ? <span className="text-xs">{m.name}</span> : dash),
  },
  {
    id: "where",
    header: "Location",
    cell: (m) => <WhereCell here={m.here} loc={m.location} />,
  },
]

/** `here`, or an arrow to where the MAC really sits. */
export function WhereCell({
  here,
  loc,
}: {
  here: boolean
  loc: MacLocationRef | null
}) {
  if (here) return <span className="text-xs text-muted-foreground">here</span>
  if (!loc) return dash
  return (
    <span className="inline-flex items-center gap-1.5 text-xs whitespace-nowrap">
      <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" />
      <LocationRef loc={loc} />
      {/* No access port reports it: this is as near as it can be placed. */}
      {loc.kind === "behind_uplink" && (
        <UplinkBadge uplink={{ mode: "auto", reasons: [] }} small />
      )}
    </span>
  )
}

/** Where a MAC list row's MAC was learned (#344): switch · port, then its
 * site and location and when it was last seen there. */
export function LearnedAtCell({ loc }: { loc: MacListLocation | null }) {
  if (!loc) return dash
  const place = [loc.site?.name, loc.location?.name].filter(Boolean)
  return (
    <span className="flex flex-col gap-0.5 text-xs whitespace-nowrap">
      <span className="inline-flex items-center gap-1.5">
        <LocationRef loc={loc} />
        {loc.kind === "behind_uplink" && (
          <UplinkBadge uplink={{ mode: "auto", reasons: [] }} small />
        )}
      </span>
      <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
        {place.length > 0 && <span>{place.join(" · ")}</span>}
        {place.length > 0 && <span>·</span>}
        <TimeCell iso={loc.last_seen} />
      </span>
    </span>
  )
}

/** The uplink chip, its reasons in the shared tooltip - one per line. */
export function UplinkBadge({
  uplink,
  label = "uplink",
  small = false,
}: {
  uplink: Pick<UplinkState, "mode" | "reasons">
  label?: string
  small?: boolean
}) {
  const reasons = uplink.reasons.length
    ? uplink.reasons.map((r) => r.text)
    : uplink.mode === "always"
      ? ["Set on the interface"]
      : []
  const badge = (
    <Badge
      variant="secondary"
      className={cn("cursor-default", small && "h-4 px-1.5 text-[10px]")}
    >
      {label}
    </Badge>
  )
  if (!reasons.length) return badge
  return (
    <Tooltip>
      <TooltipTrigger asChild>{badge}</TooltipTrigger>
      <TooltipContent variant="panel" className="flex-col items-start gap-0.5">
        {reasons.map((r) => (
          <span key={r}>{r}</span>
        ))}
      </TooltipContent>
    </Tooltip>
  )
}

/** `sw-acc-07 · Gi1/0/12` - the device and port, each linked. */
export function LocationRef({
  loc,
  size = "text-xs",
}: {
  loc: MacLocationRef
  /** Text size - 13px on an overview card. */
  size?: "text-xs" | "text-[11px]" | "text-[13px]"
}) {
  const port = loc.interface?.name ?? loc.port_name
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <Link
        to="/devices/$id"
        params={{ id: loc.device.id }}
        className={cn("link font-mono", size)}
      >
        {loc.device.name}
      </Link>
      <span className="text-muted-foreground">·</span>
      {loc.interface ? (
        <Link
          to="/interfaces/$id"
          params={{ id: loc.interface.id }}
          className={cn("link font-mono", size)}
        >
          {port}
        </Link>
      ) : (
        <span className={cn("font-mono", size)}>{port}</span>
      )}
    </span>
  )
}

/** Refresh MACs for a device - the same button on the SNMP tab, the
 * Components toolbar and an interface's MACs tab. While a run is going it
 * reads `Refreshing…` at the same width. */
export function RefreshMacsButton({
  deviceId,
  className,
}: {
  deviceId: string
  className?: string
}) {
  const { refresh, pending } = useMacRefresh(deviceId)
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={refresh}
      className={className}
    >
      <ListRestart className="h-3.5 w-3.5" />
      {/* Both labels share one cell, so the button never changes size. */}
      <span className="grid">
        <span className={cn("col-start-1 row-start-1", pending && "invisible")}>
          Refresh MACs
        </span>
        <span
          className={cn("col-start-1 row-start-1", !pending && "invisible")}
        >
          Refreshing…
        </span>
      </span>
    </Button>
  )
}

/** Present / Gone as the shared Badge - never a dot. A present MAC whose
 * switch has not finished a read for a day reads Stale. */
export function MacStateBadge({
  state,
  stale = false,
}: {
  state: "present" | "gone"
  stale?: boolean
}) {
  if (state === "gone") return <Badge variant="secondary">Gone</Badge>
  return stale ? (
    <Badge variant="warning">Stale</Badge>
  ) : (
    <Badge variant="success">Present</Badge>
  )
}
