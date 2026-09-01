import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { CustomFieldValues } from "@/components/custom-field-display"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import {
  Bookmark,
  Cable as CableIcon,
  Layers,
  Pencil,
  Trash2,
  TriangleAlert,
  Workflow,
} from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import {
  api,
  type Interface,
  type InterfaceLagSummary,
  type SnmpDriftItem,
} from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { buildInterfaceColumns } from "@/components/columns/interface-columns"
import { DriftDescription, driftKey } from "@/components/drift-detail"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { hereUrl } from "@/lib/return-url"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { InterfaceDeleteDialog } from "@/components/interface-delete-dialog"
import {
  MarkConnectedToggle,
  PortReservationDialog,
  ReservedBadge,
  UndocumentedBadge,
} from "@/components/port-reservation-dialog"
import {
  AssignIpDialog,
  type AssignIpTarget,
} from "@/components/assign-ip-dialog"
import { TraceSection } from "@/components/topology/trace-section"
import { TracePathStrip, TracePreview } from "@/components/cable-trace-path"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { VlanBadge } from "@/components/cells/vlan-badge"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/interfaces/$id")({
  component: InterfaceDetail,
})

function InterfaceDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["interface", id],
    queryFn: () => api<Interface>(`/api/interfaces/${id}/`),
  })
  if (q.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body iface={q.data} />
}

function Body({ iface: i }: { iface: Interface }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "ips" | "members" | "trace" | "journal" | "history"
  >("overview")
  const isLag = i.type === "lag"
  // The bundle summary (members, capacity, peers) - aggregates only.
  const lag = useQuery({
    queryKey: ["interface-lag", i.id],
    queryFn: () => api<InterfaceLagSummary>(`/api/interfaces/${i.id}/lag/`),
    enabled: isLag,
  })
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<Interface | null>(null)
  const [assignTarget, setAssignTarget] = useState<AssignIpTarget | null>(null)
  const [reserving, setReserving] = useState(false)
  const goBack = useCallback(() => nav({ to: "/interfaces" }), [nav])
  const canAddIp = canDo("ipaddress", "add")
  const canAssignIp = canDo("ipaddress", "change")

  return (
    <DetailShell
      // An interface always belongs to a device - back leads home to its
      // Components tab, not the flat interfaces list (the sidebar covers
      // that). Clicking a faceplate port and stepping straight back is the
      // common loop.
      backTo="/devices/$id"
      backParams={{ id: i.device.id }}
      backSearch={{ tab: "components" }}
      backLabel={i.device.name}
      crumbs={
        <Link to="/interfaces" className="link">
          Interfaces
        </Link>
      }
      title={<span className="font-mono">{i.name}</span>}
      presence={{ type: "interface", id: i.id }}
      actions={
        <>
          {canDo("cable", "add") && i.cable_count === 0 && (
            <Button variant="outline" size="sm" asChild>
              <Link
                to="/cables/new"
                search={{ a_kind: "interface", a_id: i.id, ret: hereUrl() }}
              >
                <CableIcon className="h-3.5 w-3.5" /> Connect cable
              </Link>
            </Button>
          )}
          {!i.cable &&
            !i.virtual &&
            !i.mark_connected &&
            (canDo("portreservation", "add") || i.reservation) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReserving(true)}
              >
                <Bookmark className="h-3.5 w-3.5" />{" "}
                {i.reservation ? "Reservation" : "Reserve port"}
              </Button>
            )}
          {!i.cable && !i.virtual && !i.reservation && (
            <MarkConnectedToggle
              endpoint="/api/interfaces/"
              portId={i.id}
              name={i.name}
              marked={i.mark_connected}
              canEdit={canDo("interface", "change")}
              labeled
            />
          )}
          {canDo("interface", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/interfaces/$id/edit" params={{ id: i.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("interface", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(i)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={i.name}
          mono
          subtitle={
            <>
              {i.enabled ? (
                <Badge variant="success">Enabled</Badge>
              ) : (
                <Badge variant="secondary">Disabled</Badge>
              )}
              {isLag ? (
                <Badge variant="secondary" className="gap-1">
                  <Layers className="h-3 w-3" /> Aggregate
                </Badge>
              ) : (
                i.virtual && <Badge variant="secondary">Virtual</Badge>
              )}
              {i.lag && (
                <Link to="/interfaces/$id" params={{ id: i.lag.id }}>
                  <Badge variant="secondary" className="gap-1 hover:bg-muted">
                    <Layers className="h-3 w-3" />
                    Member of {i.lag.name}
                    {lacpLabel(i.lag) ? ` · ${lacpLabel(i.lag)}` : ""}
                    {i.lag.device.id !== i.device.id
                      ? ` · on ${i.lag.device.name}`
                      : ""}
                  </Badge>
                </Link>
              )}
              {!i.cable && i.mark_connected && <UndocumentedBadge />}
              {!i.cable && !i.mark_connected && i.reservation && (
                <ReservedBadge reservation={i.reservation} />
              )}
              {i.tunnel_terminations.map((tt) => (
                <Link
                  key={tt.id}
                  to="/tunnels/$id"
                  params={{ id: tt.tunnel.id }}
                  title={`${tt.role_display} termination on tunnel ${tt.tunnel.name}`}
                >
                  <Badge variant="secondary" className="gap-1 hover:bg-muted">
                    <Workflow className="h-3 w-3" />
                    {tt.tunnel.name}
                  </Badge>
                </Link>
              ))}
            </>
          }
          tags={i.tags.length > 0 && <TagList tags={i.tags} />}
          stats={
            <>
              <DetailStat
                label="Device"
                value={
                  <Link
                    to="/devices/$id"
                    params={{ id: i.device.id }}
                    className="link font-mono"
                  >
                    {i.device.name}
                  </Link>
                }
              />
              <DetailStat
                label="Type"
                value={
                  i.type ? (
                    <span className="font-mono text-[13px]">
                      {i.type_display}
                    </span>
                  ) : (
                    dash
                  )
                }
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "ips",
          label: "IP addresses",
          count: i.ip_addresses.length,
        },
        ...(isLag
          ? [{ value: "members", label: "Members", count: lag.data?.count }]
          : []),
        { value: "trace", label: "Trace" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <InterfaceOverview
          iface={i}
          lag={isLag ? lag.data : undefined}
          onMembers={() => setTab("members")}
        />
      </DetailTab>
      {isLag && (
        <DetailTab value="members">
          <LagMembers iface={i} summary={lag.data} loading={lag.isLoading} />
        </DetailTab>
      )}
      <DetailTab value="ips">
        <div className="mb-3 flex items-center justify-end gap-1.5">
          {canAddIp && (
            <Button size="sm" variant="outline" asChild className="h-7">
              <Link
                to="/ips/new"
                search={{ device: i.device.id, interface: i.id }}
              >
                + Add IP
              </Link>
            </Button>
          )}
          {canAssignIp && (
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() =>
                setAssignTarget({
                  deviceId: i.device.id,
                  interfaceId: i.id,
                  interfaceName: i.name,
                })
              }
            >
              Assign IP
            </Button>
          )}
        </div>
        {i.ip_addresses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No IP is assigned to this interface yet.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <ul className="divide-y divide-border">
              {i.ip_addresses.map((ip) => (
                <li key={ip.id}>
                  <Link
                    to="/ips/$id"
                    params={{ id: ip.id }}
                    className="link block px-3 py-2 font-mono text-[13px] hover:bg-muted/60"
                  >
                    {ip.ip_address}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </DetailTab>
      <DetailTab value="trace">
        <div className="space-y-6">
          <TracePathStrip
            url={`/api/interfaces/${i.id}/trace/`}
            queryKey={["trace", "interface", i.id]}
            highlightPort={i.name}
          />
          <TraceSection
            url={`/api/interfaces/${i.id}/trace/`}
            queryKey={["trace", "interface", i.id]}
            focusNodeId={`dev:${i.device.id}`}
            urlKey="dir"
          />
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.interface" objectId={i.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.interface" objectId={i.id} />
      </DetailTab>

      <InterfaceDeleteDialog
        iface={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
      <AssignIpDialog
        target={assignTarget}
        onOpenChange={(o) => !o && setAssignTarget(null)}
      />
      <PortReservationDialog
        target={
          reserving
            ? {
                kind: "interface",
                id: i.id,
                name: i.name,
                reservation: i.reservation,
              }
            : null
        }
        onClose={() => setReserving(false)}
      />
    </DetailShell>
  )
}

/** The interface's attributes, grouped into labelled tables - the detail that
 * used to crowd the page header. Only headline data (name, state, device,
 * type) stays up top; everything else reads here. */
function InterfaceOverview({
  iface: i,
  lag,
  onMembers,
}: {
  iface: Interface
  /** The bundle summary - set for aggregates once loaded. */
  lag?: InterfaceLagSummary
  onMembers: () => void
}) {
  const attributes: KvRow[] = [
    {
      label: "Enabled",
      value: i.enabled ? "Yes" : "No",
    },
    // The hold's who/why - the badge alone says "Reserved" but not by whom
    // or what for, and that context is the whole point of a reservation.
    ...(!i.cable && !i.mark_connected && i.reservation
      ? [
          {
            label: "Reserved",
            value: (
              <span className="text-[13px]">
                {i.reservation.note || "No note"}
                <span className="text-muted-foreground">
                  {i.reservation.claimed_by
                    ? ` - by ${i.reservation.claimed_by}`
                    : ""}
                  {" · "}
                  <TimeCell iso={i.reservation.created_at} />
                </span>
              </span>
            ),
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Management only",
      value: i.mgmt_only ? "Yes" : "No",
    },
    {
      label: "Type",
      value: i.type ? (
        <span className="font-mono text-[13px]">{i.type_display}</span>
      ) : (
        dash
      ),
    },
    { label: "Speed", value: i.speed || dash },
    { label: "Duplex", value: i.duplex || dash },
    {
      label: "PoE",
      value: i.poe_mode ? (
        <span>
          {i.poe_mode.toUpperCase()}
          {i.poe_type && (
            <span className="ml-1.5 text-muted-foreground">{i.poe_type}</span>
          )}
        </span>
      ) : (
        dash
      ),
    },
    {
      label: "WWN",
      value: i.wwn ? (
        <span className="font-mono text-[13px]">{i.wwn}</span>
      ) : (
        dash
      ),
    },
    {
      label: "MTU",
      value: i.mtu != null ? <span className="num">{i.mtu}</span> : dash,
    },
    {
      label: "MAC addresses",
      value:
        i.mac_addresses.length > 0 ? (
          <span className="flex flex-wrap items-center gap-2">
            {i.mac_addresses.map((m) => (
              <span key={m.id} className="inline-flex items-center gap-1">
                <Link
                  to="/macs/$mac"
                  params={{ mac: m.mac_address }}
                  className="link font-mono text-[13px]"
                >
                  {m.mac_address}
                </Link>
                {m.is_primary && i.mac_addresses.length > 1 && (
                  <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                    primary
                  </Badge>
                )}
              </span>
            ))}
          </span>
        ) : (
          dash
        ),
    },
    { label: "Cables", value: <span className="num">{i.cable_count}</span> },
    { label: "Description", value: i.description || dash },
  ]

  const switching: KvRow[] = [
    { label: "802.1Q mode", value: i.mode_display || dash },
    {
      label: "Untagged VLAN",
      value: i.vlan ? <VlanBadge vlan={i.vlan} /> : dash,
    },
    {
      label: "Tagged VLANs",
      value:
        i.tagged_vlans.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {i.tagged_vlans.map((v) => (
              <VlanBadge key={v.id} vlan={v} />
            ))}
          </span>
        ) : (
          dash
        ),
    },
    {
      label: "VRF",
      value: i.vrf ? (
        <Link
          to="/vrfs/$id"
          params={{ id: i.vrf.id }}
          className="link text-[13px]"
        >
          {i.vrf.name}
        </Link>
      ) : (
        <span className="text-muted-foreground">Global</span>
      ),
    },
  ]

  const relationships: KvRow[] = [
    {
      label: "Parent",
      value: i.parent ? (
        <Link
          to="/interfaces/$id"
          params={{ id: i.parent.id }}
          className="link font-mono"
        >
          {i.parent.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "LAG",
      value: i.lag ? (
        <Link
          to="/interfaces/$id"
          params={{ id: i.lag.id }}
          className="link font-mono"
        >
          {i.lag.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Bridge",
      value: i.bridge ? (
        <Link
          to="/interfaces/$id"
          params={{ id: i.bridge.id }}
          className="link font-mono"
        >
          {i.bridge.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Tunnels",
      value:
        i.tunnel_terminations.length > 0 ? (
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {i.tunnel_terminations.map((tt) => (
              <span key={tt.id} className="inline-flex items-center gap-1">
                <Link
                  to="/tunnels/$id"
                  params={{ id: tt.tunnel.id }}
                  className="link text-[13px]"
                >
                  {tt.tunnel.name}
                </Link>
                <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                  {tt.role_display}
                </Badge>
              </span>
            ))}
          </span>
        ) : (
          dash
        ),
    },
    {
      label: "Sub-interfaces",
      value: <span className="num">{i.child_count}</span>,
    },
  ]

  // The bundle at a glance. Peers are where the members' cables land: one
  // aggregate on one device is the plain case; two is MLAG/vPC and reads as
  // information, never a fault.
  const bundle: KvRow[] | null =
    i.type === "lag"
      ? [
          { label: "Protocol", value: i.lag_protocol_display || "Static" },
          ...(i.lag_protocol === "lacp"
            ? [
                { label: "LACP mode", value: i.lacp_mode || dash },
                { label: "LACP rate", value: i.lacp_rate || dash },
              ]
            : []),
          {
            label: "Min links",
            value: i.lag_min_links != null ? (
              <span className="inline-flex items-center gap-2">
                <span className="num">{i.lag_min_links}</span>
                {lag?.degraded && (
                  <Badge variant="warning">below min links</Badge>
                )}
              </span>
            ) : (
              dash
            ),
          },
          {
            label: "Members",
            value: (
              <button
                type="button"
                onClick={onMembers}
                className="link num text-left"
              >
                {lag ? lag.count : i.lag_member_count}
              </button>
            ),
          },
          {
            label: "Capacity",
            value: lag?.capacity ? (
              <span className="inline-flex items-center gap-2">
                <span className="num">{lag.capacity}</span>
                {lag.unparsed_speeds > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    {lag.unparsed_speeds} without a speed
                  </span>
                )}
              </span>
            ) : (
              dash
            ),
          },
          {
            label: lag && lag.peers.length > 1 ? "Peer aggregates" : "Peer aggregate",
            value: lag && lag.peers.length > 0 ? (
              <span className="flex flex-col gap-0.5">
                {lag.peers.map((p) => (
                  <Link
                    key={p.id}
                    to="/interfaces/$id"
                    params={{ id: p.id }}
                    className="link font-mono text-[13px]"
                  >
                    {p.device.name}: {p.name}
                    <span className="pl-1 text-muted-foreground">
                      · {p.members} {p.members === 1 ? "link" : "links"}
                    </span>
                  </Link>
                ))}
                {lag.mixed_peers && (
                  <span className="text-[11px] text-muted-foreground">
                    Ends on {lag.peers.length} devices - only valid for an
                    MLAG / vPC pair
                  </span>
                )}
                {lag.unpaired.length > 0 && (
                  <span className="text-[11px] text-muted-foreground">
                    No peer aggregate: {lag.unpaired.join(", ")}
                  </span>
                )}
              </span>
            ) : lag && lag.unpaired.length > 0 ? (
              <span className="text-[11px] text-muted-foreground">
                No peer aggregate: {lag.unpaired.join(", ")}
              </span>
            ) : (
              dash
            ),
          },
        ]
      : null

  return (
    <div className="space-y-6">
      <InterfaceDriftAlert deviceId={i.device.id} interfaceId={i.id} />
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <KvCard title="Interface" rows={attributes} />
          {bundle && <KvCard title="Bundle" rows={bundle} />}
          <KvCard title="Switching" rows={switching} />
          <KvCard title="Relationships" rows={relationships} />
          {i.ip_addresses.length > 0 && (
            // The addresses at a glance - the IP tab stays where they're
            // assigned and removed.
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="flex items-center justify-between border-b border-border px-4 py-2">
                <h2 className="text-sm font-semibold">IP addresses</h2>
                <Badge variant="secondary">{i.ip_addresses.length}</Badge>
              </div>
              <ul className="divide-y divide-border">
                {i.ip_addresses.map((ip) => (
                  <li key={ip.id}>
                    <Link
                      to="/ips/$id"
                      params={{ id: ip.id }}
                      className="link block px-4 py-2 font-mono text-[13px] hover:bg-muted/60"
                    >
                      {ip.ip_address}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <CustomFieldValues
            model="interface"
            values={i.custom_fields}
            layout="cards"
          />
        </div>
        {i.cable && (
          <div className="rounded-lg border border-border bg-card p-4">
            <TracePreview
              url={`/api/interfaces/${i.id}/trace/`}
              queryKey={["trace", "interface", i.id]}
              highlightPort={i.name}
              originInterfaceId={i.id}
              originDeviceId={i.device.id}
            />
          </div>
        )}
      </div>
    </div>
  )
}

// Config-drift callout on the interface detail page - lists exactly what SNMP
// observed that differs from the source of truth, with a link into the device's
// Drift panel to review/accept. Renders nothing when there's no drift.
function InterfaceDriftAlert({
  deviceId,
  interfaceId,
}: {
  deviceId: string
  interfaceId: string
}) {
  const q = useQuery({
    queryKey: ["device-snmp-drift", deviceId],
    queryFn: () =>
      api<{ drift: SnmpDriftItem[] }>(
        `/api/monitoring/devices/${deviceId}/snmp/drift/`
      ),
  })
  const items = (q.data?.drift ?? []).filter(
    (it) => "interface_id" in it && it.interface_id === interfaceId
  )
  if (items.length === 0) return null
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4">
      <div className="mb-1.5 flex items-center gap-2 text-sm font-semibold text-amber-700 dark:text-amber-400">
        <TriangleAlert className="h-4 w-4" />
        Config drift on this interface
      </div>
      <p className="mb-2 text-[12px] text-muted-foreground">
        SNMP observed values that differ from the source of truth. Review and
        accept them in the device's{" "}
        <Link to="/devices/$id" params={{ id: deviceId }} className="link">
          Drift panel
        </Link>{" "}
        - nothing changes here until you do.
      </p>
      <ul className="space-y-1.5 text-[13px]">
        {items.map((it) => (
          <li key={driftKey(it)}>
            <DriftDescription item={it} />
          </li>
        ))}
      </ul>
    </div>
  )
}

/** "LACP active" / "LACP" / "PAgP" for a member's chip; "" for static. */
function lacpLabel(lag: NonNullable<Interface["lag"]>): string {
  if (lag.lag_protocol === "lacp")
    return lag.lacp_mode ? `LACP ${lag.lacp_mode}` : "LACP"
  if (lag.lag_protocol === "pagp") return "PAgP"
  return ""
}

/** The aggregate's members as the shared interface table. A Device column
 * appears only when the members span stack members. */
function LagMembers({
  iface,
  summary,
  loading,
}: {
  iface: Interface
  summary?: InterfaceLagSummary
  loading: boolean
}) {
  const rows = summary?.results ?? []
  const spansDevices = rows.some((r) => r.device.id !== iface.device.id)
  const columns = useMemo(
    () =>
      buildInterfaceColumns<Interface>({
        include: [
          ...(spansDevices ? (["device"] as const) : []),
          "name",
          "type",
          "status",
          "enabled",
          "speed",
          "cables",
        ],
      }),
    [spansDevices]
  )
  if (loading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (rows.length === 0)
    return (
      <EmptyState title="No members yet">
        Set a port's LAG / aggregate field to {iface.name} to add it.
      </EmptyState>
    )
  return <DataTable data={rows} columns={columns} embedded />
}
