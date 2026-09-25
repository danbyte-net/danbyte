import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { StaticRoute } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { StatusBadge } from "@/components/status-badge"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { CustomFieldValues } from "@/components/custom-field-display"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { RoutingDeleteDialog } from "@/components/routing/catalog-page"
import {
  OwnerLink,
  ownerName,
  ownerOf,
  PortLink,
} from "@/components/routing/owner"

export const Route = createFileRoute("/static-routes/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["static-route", id],
    queryFn: () => api<StaticRoute>(`/api/routing/static-routes/${id}/`),
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
  return <Body r={q.data} />
}

function Body({ r }: { r: StaticRoute }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const [deleting, setDeleting] = useState<StaticRoute | null>(null)
  const goBack = useCallback(() => nav({ to: "/static-routes" }), [nav])

  const via =
    r.kind === "nexthop" || r.kind === "interface"
      ? [r.next_hop, (r.next_hop_interface ?? r.next_hop_vm_interface)?.name]
          .filter(Boolean)
          .join(" via ")
      : r.kind_display

  const details: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          },
        ]
      : []),
    {
      label: "Prefix",
      value: <span className="font-mono">{r.prefix}</span>,
      copy: r.prefix,
    },
    {
      label: "IPAM prefix",
      value: r.prefix_obj ? (
        <Link
          to="/prefixes/$id"
          params={{ id: r.prefix_obj.id }}
          className="link font-mono"
        >
          {r.prefix_obj.cidr}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: r.virtual_machine ? "Virtual machine" : "Device",
      value: <OwnerLink owner={ownerOf(r)} tab="overview" className="link" />,
    },
    {
      label: "VRF",
      value: r.vrf ? (
        <Link to="/vrfs/$id" params={{ id: r.vrf.id }} className="inline-flex">
          <ColorBadge name={r.vrf.name} color={r.vrf.color} />
        </Link>
      ) : (
        "Global"
      ),
    },
    { label: "Status", value: <StatusBadge status={r.status} /> },
    { label: "Description", value: r.description || dash },
  ]
  const path: KvRow[] = [
    { label: "Kind", value: r.kind_display },
    {
      label: "Next hop",
      value: r.next_hop ? (
        <span className="font-mono">{r.next_hop}</span>
      ) : (
        dash
      ),
    },
    {
      label: "Interface",
      value: (
        <PortLink
          iface={r.next_hop_interface}
          vmIface={r.next_hop_vm_interface}
        />
      ),
    },
    {
      label: "Next hop VRF",
      value: r.next_hop_vrf ? (
        <ColorBadge name={r.next_hop_vrf.name} color={r.next_hop_vrf.color} />
      ) : (
        dash
      ),
    },
    {
      label: "Distance",
      value:
        r.distance != null ? <span className="num">{r.distance}</span> : dash,
    },
    {
      label: "Metric",
      value: r.metric != null ? <span className="num">{r.metric}</span> : dash,
    },
    {
      label: "Tag",
      value: r.tag != null ? <span className="num">{r.tag}</span> : dash,
    },
    { label: "BFD", value: r.bfd ? "On" : "Off" },
  ]
  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <DetailShell
      backTo="/static-routes"
      backLabel="Static routes"
      title={r.prefix}
      presence={{ type: "staticroute", id: r.id }}
      actions={
        <>
          {canDo("staticroute", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/static-routes/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("staticroute", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(r)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <DetailHero
          title={r.prefix}
          mono
          badges={<StatusBadge status={r.status} />}
          subtitle={
            <span className="font-mono">
              {ownerName(r)} · {r.vrf?.name ?? "Global"} · {via}
            </span>
          }
          description={r.description}
          tags={r.tags.length ? <TagList tags={r.tags} /> : undefined}
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Route" rows={details} />
          <KvCard title="Path" rows={path} />
          <KvCard title="Record" rows={record} />
          <CustomFieldValues
            model="staticroute"
            values={r.custom_fields}
            layout="cards"
          />
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="routing.staticroute" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="routing.staticroute" objectId={r.id} />
      </DetailTab>
      <RoutingDeleteDialog
        item={deleting}
        endpoint="/api/routing/static-routes/"
        queryKey="static-routes"
        label={(x) => x.prefix}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}
