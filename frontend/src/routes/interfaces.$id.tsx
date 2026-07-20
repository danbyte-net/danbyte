import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Cable as CableIcon, Pencil, Trash2, Workflow } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type Interface } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { TagList } from "@/components/cells/tag-list"
import { KvCard, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { InterfaceDeleteDialog } from "@/components/interface-delete-dialog"
import {
  AssignIpDialog,
  type AssignIpTarget,
} from "@/components/assign-ip-dialog"
import { TraceSection } from "@/components/topology/trace-section"
import { TracePathStrip, TracePreview } from "@/components/cable-trace-path"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
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
    "overview" | "ips" | "trace" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<Interface | null>(null)
  const [assignTarget, setAssignTarget] = useState<AssignIpTarget | null>(null)
  const goBack = useCallback(() => nav({ to: "/interfaces" }), [nav])
  const canAddIp = canDo("ipaddress", "add")
  const canAssignIp = canDo("ipaddress", "change")

  return (
    <DetailShell
      backTo="/interfaces"
      backLabel="Interfaces"
      crumbs={
        <Link
          to="/devices/$id"
          params={{ id: i.device.id }}
          className="font-mono hover:underline"
        >
          {i.device.name}
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
                search={{ a_kind: "interface", a_id: i.id }}
              >
                <CableIcon className="h-3.5 w-3.5" /> Connect cable
              </Link>
            </Button>
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
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="font-mono text-2xl font-semibold tracking-tight">
              {i.name}
            </div>
            <div className="mt-2 flex items-center gap-1.5">
              {i.enabled ? (
                <Badge variant="success">Enabled</Badge>
              ) : (
                <Badge variant="secondary">Disabled</Badge>
              )}
              {i.virtual && <Badge variant="secondary">Virtual</Badge>}
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
            </div>
            {i.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={i.tags} />
              </div>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
            <DetailStat
              label="Device"
              value={
                <Link
                  to="/devices/$id"
                  params={{ id: i.device.id }}
                  className="font-mono text-primary hover:underline"
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
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "ips",
          label: "IP addresses",
          count: i.ip_addresses.length,
        },
        { value: "trace", label: "Trace" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <InterfaceOverview iface={i} />
      </DetailTab>
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
                    className="block px-3 py-2 font-mono text-[13px] text-primary hover:bg-muted/60 hover:underline"
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
    </DetailShell>
  )
}

/** The interface's attributes, grouped into labelled tables — the detail that
 * used to crowd the page header. Only headline data (name, state, device,
 * type) stays up top; everything else reads here. */
function InterfaceOverview({ iface: i }: { iface: Interface }) {
  const attributes: KvRow[] = [
    {
      label: "Enabled",
      value: i.enabled ? "Yes" : "No",
    },
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
                  className="font-mono text-[13px] text-primary hover:underline"
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
  ]

  const switching: KvRow[] = [
    { label: "802.1Q mode", value: i.mode_display || dash },
    {
      label: "Untagged VLAN",
      value: i.vlan ? (
        <Link
          to="/vlans/$id"
          params={{ id: i.vlan.id }}
          className="font-mono text-[13px] text-primary hover:underline"
        >
          {i.vlan.vlan_id} · {i.vlan.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Tagged VLANs",
      value:
        i.tagged_vlans.length > 0 ? (
          <span className="flex flex-wrap gap-1">
            {i.tagged_vlans.map((v) => (
              <Link
                key={v.id}
                to="/vlans/$id"
                params={{ id: v.id }}
                className="font-mono text-[12px] text-primary hover:underline"
              >
                {v.vlan_id}
              </Link>
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
          className="text-[13px] text-primary hover:underline"
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
          className="font-mono text-primary hover:underline"
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
          className="font-mono text-primary hover:underline"
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
          className="font-mono text-primary hover:underline"
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
                  className="text-[13px] text-primary hover:underline"
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
    ...(i.lag_member_count > 0
      ? [
          {
            label: "LAG members",
            value: <span className="num">{i.lag_member_count}</span>,
          } satisfies KvRow,
        ]
      : []),
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <KvCard title="Interface" rows={attributes} />
        <KvCard title="Switching" rows={switching} />
        <KvCard title="Relationships" rows={relationships} />
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
  )
}
