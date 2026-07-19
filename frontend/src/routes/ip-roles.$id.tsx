import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type IPRole } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { QueryError } from "@/components/query-error"
import { IpRoleDeleteDialog } from "@/components/ip-role-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
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
  const [tab, setTab] = useState<"ips" | "journal" | "history">("ips")
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
          <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
            <div className="min-w-0">
              <ColorBadge name={r.name} color={r.color || undefined} />
              <div className="mt-2 flex flex-wrap gap-1.5">
                {flags.map((f) => (
                  <Badge key={f} variant="secondary">
                    {f}
                  </Badge>
                ))}
                {r.icon && (
                  <Badge variant="secondary" className="font-mono">
                    {r.icon}
                  </Badge>
                )}
              </div>
              {r.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {r.description}
                </p>
              )}
            </div>
            <dl className="ml-auto grid grid-cols-2 gap-x-8 gap-y-3 text-[13px]">
              <DetailStat
                label="IPs"
                value={<span className="num">{r.usage_count}</span>}
              />
              <DetailStat
                label="Weight"
                value={<span className="num">{r.weight}</span>}
              />
            </dl>
          </section>

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
        { value: "ips", label: "IPs", count: r.usage_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
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
