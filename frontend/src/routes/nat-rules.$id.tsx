import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRight, Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { NATRule } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { StatusBadge } from "@/components/status-badge"
import { TagList } from "@/components/cells/tag-list"
import { TimeCell } from "@/components/cells/time-ago"
import { QueryError } from "@/components/query-error"
import { CustomFieldValues } from "@/components/custom-field-display"
import {
  NATRuleDeleteDialog,
  NATRuleFormDialog,
} from "@/components/nat-rule-dialogs"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/nat-rules/$id")({
  component: NATRuleDetail,
})

function NATRuleDetail() {
  const { id } = Route.useParams()
  const query = useQuery({
    queryKey: ["nat-rule", id],
    queryFn: () => api<NATRule>(`/api/nat-rules/${id}/`),
  })

  if (query.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (query.isError)
    return (
      <div className="p-6">
        <QueryError error={query.error} />
      </div>
    )
  if (!query.data) return null
  return <NATRuleDetailBody rule={query.data} />
}

/** One end, as an operator writes it: 203.0.113.10:443. */
function EndpointRow({
  ip,
  ports,
}: {
  ip: NATRule["external_ip"]
  ports: string
}) {
  if (!ip && !ports) return dash
  return (
    <span className="font-mono">
      {ip ? (
        <Link to="/ips/$id" params={{ id: ip.id }} className="link">
          {ip.ip_address}
        </Link>
      ) : (
        <span className="text-muted-foreground">any</span>
      )}
      {ports && <span className="text-muted-foreground">:{ports}</span>}
    </span>
  )
}

function NATRuleDetailBody({ rule: r }: { rule: NATRule }) {
  const [tab, setTab] = useUrlTab<"overview" | "journal" | "history">(
    "overview"
  )
  const { canDo } = useMe()
  const nav = useNavigate()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [deleting, setDeleting] = useState<NATRule | null>(null)
  const goBack = useCallback(() => nav({ to: "/nat-rules" }), [nav])

  const from = r.source_ip?.ip_address ?? r.source_prefix?.cidr ?? ""
  const detailRows: KvRow[] = [
    { label: "Type", value: r.kind_display },
    { label: "Protocol", value: r.protocol_display },
    {
      label: "Firewall",
      value: r.device ? (
        <Link to="/devices/$id" params={{ id: r.device.id }} className="link">
          {r.device.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Status",
      value: r.status ? <StatusBadge status={r.status} /> : dash,
    },
    {
      label: "From",
      value: from ? (
        <span className="font-mono">{from}</span>
      ) : (
        <span className="text-muted-foreground">Anywhere</span>
      ),
    },
  ]

  const translationRows: KvRow[] = [
    {
      label: "Outside",
      value: <EndpointRow ip={r.external_ip} ports={r.external_ports} />,
      copy: r.external_ip?.ip_address,
    },
    {
      label: "Inside",
      value: <EndpointRow ip={r.internal_ip} ports={r.internal_ports} />,
      copy: r.internal_ip?.ip_address,
    },
  ]

  return (
    <DetailShell
      backTo="/nat-rules"
      backLabel="NAT rules"
      title={r.name}
      actions={
        <>
          {canDo("natrule", "change") && (
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
          {canDo("natrule", "delete") && (
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
          title={r.name}
          badges={
            // The mapping itself, in the hero: it is what the page is about,
            // and it is the line somebody came here to read.
            <span className="flex items-center gap-2 font-mono text-sm">
              <EndpointRow ip={r.external_ip} ports={r.external_ports} />
              <ArrowRight className="size-3.5 text-muted-foreground" />
              <EndpointRow ip={r.internal_ip} ports={r.internal_ports} />
            </span>
          }
          tags={r.tags.length > 0 && <TagList tags={r.tags} />}
          description={r.description}
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
          <KvCard title="Translation" rows={translationRows} />
          <KvCard title="Details" rows={detailRows} />
          <CustomFieldValues
            model="natrule"
            values={r.custom_fields}
            layout="cards"
          />
        </div>

        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground/70">Created</span>
            <TimeCell iso={r.created_at} />
          </span>
          <span className="flex items-center gap-1">
            <span className="text-muted-foreground/70">Updated</span>
            <TimeCell iso={r.updated_at} />
          </span>
        </div>
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.natrule" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.natrule" objectId={r.id} />
      </DetailTab>

      <NATRuleFormDialog
        rule={r}
        open={editing}
        onOpenChange={setEditing}
        onSaved={() => {
          setEditing(false)
          void qc.invalidateQueries({ queryKey: ["nat-rule", r.id] })
        }}
      />
      <NATRuleDeleteDialog
        rule={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}
