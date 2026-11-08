import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { PolicyRule } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { useUrlTab } from "@/lib/use-url-tab"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { StatusBadge } from "@/components/status-badge"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { CustomFieldValues } from "@/components/custom-field-display"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { RoutingDeleteDialog } from "@/components/routing/catalog-page"
import {
  familyLabel,
  policyRuleSelector,
} from "@/components/columns/routing-columns"
import {
  OwnerLink,
  ownerName,
  ownerOf,
  PortLink,
} from "@/components/routing/owner"

export const Route = createFileRoute("/policy-rules/$id")({
  component: Page,
})

function Page() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["policy-rule", id],
    queryFn: () => api<PolicyRule>(`/api/routing/ip-rules/${id}/`),
  })
  if (q.isLoading) return <Loading />
  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (!q.data) return null
  return <Body r={q.data} />
}

function Body({ r }: { r: PolicyRule }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const [deleting, setDeleting] = useState<PolicyRule | null>(null)
  const goBack = useCallback(() => nav({ to: "/policy-rules" }), [nav])
  const title = `Rule ${r.priority}`

  const rule: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          },
        ]
      : []),
    {
      label: r.virtual_machine ? "Virtual machine" : "Device",
      value: <OwnerLink owner={ownerOf(r)} tab="overview" className="link" />,
    },
    { label: "Priority", value: <span className="num">{r.priority}</span> },
    { label: "Family", value: familyLabel(r.family) },
    { label: "Action", value: r.action_display },
    {
      label: "Table",
      value: r.vrf ? (
        <Link to="/vrfs/$id" params={{ id: r.vrf.id }} className="inline-flex">
          <ColorBadge name={r.vrf.name} color={r.vrf.color} />
        </Link>
      ) : r.table != null ? (
        <span className="num">{r.table}</span>
      ) : (
        dash
      ),
    },
    { label: "Status", value: <StatusBadge status={r.status} /> },
    { label: "Description", value: r.description || dash },
  ]
  const match: KvRow[] = [
    {
      label: "From",
      value: r.from_prefix ? (
        <span className="font-mono">{r.from_prefix}</span>
      ) : (
        "All"
      ),
    },
    {
      label: "To",
      value: r.to_prefix ? (
        <span className="font-mono">{r.to_prefix}</span>
      ) : (
        "All"
      ),
    },
    {
      label: "In interface",
      value: <PortLink iface={r.iif} vmIface={r.vm_iif} />,
    },
    {
      label: "Out interface",
      value: <PortLink iface={r.oif} vmIface={r.vm_oif} />,
    },
    {
      label: "Firewall mark",
      value: r.fwmark != null ? <span className="num">{r.fwmark}</span> : dash,
    },
    { label: "Invert", value: r.invert ? "Yes" : "No" },
  ]
  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <DetailShell
      backTo="/policy-rules"
      backLabel="Policy rules"
      title={title}
      presence={{ type: "policyrule", id: r.id }}
      actions={
        <>
          {canDo("policyrule", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/policy-rules/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("policyrule", "delete") && (
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
          title={title}
          badges={<StatusBadge status={r.status} />}
          subtitle={
            <span className="font-mono">
              {ownerName(r)} · {policyRuleSelector(r)}
            </span>
          }
          description={r.description}
          tags={
            r.tags.length ? (
              <TagList tags={r.tags} listTo="/policy-rules" />
            ) : undefined
          }
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
          <KvCard title="Rule" rows={rule} />
          <KvCard title="Match" rows={match} />
          <KvCard title="Record" rows={record} />
          <CustomFieldValues
            model="policyrule"
            values={r.custom_fields}
            layout="cards"
          />
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="routing.policyrule" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="routing.policyrule" objectId={r.id} />
      </DetailTab>
      <RoutingDeleteDialog
        item={deleting}
        endpoint="/api/routing/ip-rules/"
        queryKey="policy-rules"
        label={(x) => `Rule ${x.priority}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}
