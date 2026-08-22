import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type IPRole } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash, mono } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { LocalityBadge } from "@/components/locality-badge"
import { QueryError } from "@/components/query-error"
import { IpRoleDeleteDialog } from "@/components/ip-role-delete-dialog"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { EmbeddedIpTable } from "@/components/embedded-tables"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/ip-roles/$id")({
  component: IpRoleDetail,
})

function IpRoleDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["ip-role", id],
    queryFn: () => api<IPRole>(`/api/ip-roles/${id}/`),
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
  return <Body role={q.data} />
}

function Body({ role: r }: { role: IPRole }) {
  const [tab, setTab] = useUrlTab<"overview" | "ips" | "journal" | "history">(
    "overview"
  )
  const nav = useNavigate()
  const { canDo } = useMe()
  const canEdit = canDo("iprole", "change")
  const canDelete = canDo("iprole", "delete")
  const [deleting, setDeleting] = useState<IPRole | null>(null)
  const goBack = useCallback(() => nav({ to: "/ip-roles" }), [nav])
  const flags = [r.is_gateway && "Gateway", r.is_virtual && "Virtual"].filter(
    Boolean
  ) as string[]

  return (
    <DetailShell
      backTo="/ip-roles"
      backLabel="IP roles"
      title={r.name}
      presence={{ type: "iprole", id: r.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/ip-roles/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
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
        <>
          <DetailHero
            title={<ColorBadge name={r.name} color={r.color || undefined} />}
            subtitle={flags.map((f) => (
              <Badge key={f} variant="secondary">
                {f}
              </Badge>
            ))}
            description={r.description}
            stats={
              <DetailStat
                label="IPs"
                value={<span className="num">{r.usage_count}</span>}
              />
            }
          />

          <section className="shrink-0 border-b border-border px-6 py-4">
            <p className="text-sm text-muted-foreground">
              {r.usage_count > 0
                ? `${r.usage_count} IP${r.usage_count === 1 ? "" : "s"} currently carry this role.`
                : "No IPs use this role yet."}
            </p>
          </section>
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "ips", label: "IPs", count: r.usage_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <IpRoleOverview role={r} />
      </DetailTab>
      <DetailTab value="ips">
        <EmbeddedIpTable filter={{ role: r.id }} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.iprole" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.iprole" objectId={r.id} />
      </DetailTab>

      <IpRoleDeleteDialog
        role={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** IP-role attributes that used to crowd the header, grouped into tables. Only
 * the colored name badge, flags, description and IP count stay up top. */
function IpRoleOverview({ role: r }: { role: IPRole }) {
  const attributes: KvRow[] = [
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{r.slug}</span>,
      copy: r.slug,
    },
    {
      label: "Color",
      value: r.color ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: r.color }}
          />
          <span className="font-mono">{r.color}</span>
        </span>
      ) : (
        dash
      ),
    },
    { label: "Icon", value: mono(r.icon) },
    { label: "Weight", value: <span className="num">{r.weight}</span> },
    { label: "Gateway", value: r.is_gateway ? "Yes" : "No" },
    { label: "Virtual", value: r.is_virtual ? "Yes" : "No" },
  ]

  const record: KvRow[] = [
    {
      label: "Locality",
      value: <LocalityBadge owningSite={r.owning_site} />,
    },
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Attributes" rows={attributes} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}
