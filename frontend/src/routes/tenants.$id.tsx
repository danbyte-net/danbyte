import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowRightLeft, Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"
import { toast } from "sonner"

import { api, type Tenant, type TenantPicker } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { QueryError } from "@/components/query-error"
import { TenantDeleteDialog } from "@/components/tenant-delete-dialog"
import { KvCard, type KvRow } from "@/components/kv-card"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/tenants/$id")({
  component: TenantDetail,
})

function TenantDetail() {
  const { id } = Route.useParams()
  const tenant = useQuery({
    queryKey: ["tenant", id],
    queryFn: () => api<Tenant>(`/api/tenants/${id}/`),
  })
  if (tenant.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (tenant.isError)
    return (
      <div className="p-6">
        <QueryError error={tenant.error} />
      </div>
    )
  if (!tenant.data) return null
  return <TenantDetailBody tenant={tenant.data} />
}

function TenantDetailBody({ tenant: t }: { tenant: Tenant }) {
  const [tab, setTab] = useState<"overview" | "journal" | "history">("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Tenant | null>(null)
  const qc = useQueryClient()
  const { canDo } = useMe()

  const active = useQuery({
    queryKey: ["tenant-active"],
    queryFn: () => api<TenantPicker | { id: null }>("/api/tenants/active/"),
    staleTime: 60_000,
  })
  const isActive = active.data && "id" in active.data && active.data.id === t.id

  const switchMutation = useMutation({
    mutationFn: () =>
      api<TenantPicker>(`/api/tenants/${t.id}/switch/`, { method: "POST" }),
    onSuccess: (saved) => {
      // Hard boundary: full document load so NO previous-tenant data survives
      // (invalidateQueries alone leaves mounted observers on stale rows).
      toast.success(`Switched to ${saved.name}`)
      qc.clear()
      window.location.assign("/")
    },
    onError: (err) => apiErrorToast(err),
  })

  const openDelete = useCallback(() => setDeleting(t), [t])
  const closeDelete = useCallback((o: boolean) => {
    if (!o) setDeleting(null)
  }, [])
  const goBack = useCallback(() => nav({ to: "/tenants" }), [nav])

  return (
    <DetailShell
      backTo="/tenants"
      backLabel="Tenants"
      title={t.name}
      presence={{ type: "tenant", id: t.id }}
      actions={
        <>
          {!isActive && t.is_active && (
            <Button
              size="sm"
              onClick={() => switchMutation.mutate()}
              disabled={switchMutation.isPending}
            >
              <ArrowRightLeft className="h-3.5 w-3.5" />
              {switchMutation.isPending
                ? "Switching…"
                : "Switch to this tenant"}
            </Button>
          )}
          {canDo("tenant", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/tenants/$id/edit" params={{ id: t.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("tenant", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={openDelete}
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
              <div className="flex flex-wrap items-center gap-3">
                <ColorBadge
                  name={t.name}
                  color={t.color || undefined}
                  className="h-7 px-3 text-sm"
                />
                <span className="font-mono text-sm text-muted-foreground">
                  {t.slug}
                </span>
                {isActive && <Badge variant="secondary">active</Badge>}
                {!t.is_active && <Badge variant="outline">inactive</Badge>}
              </div>
              {t.description && (
                <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                  {t.description}
                </p>
              )}
            </div>
          </section>
          <section className="shrink-0 border-b border-border px-6 py-4">
            <p className="text-sm text-muted-foreground">
              Switch to this tenant to browse its sites, prefixes, VLANs, and
              IPs. The lists in the sidebar always scope to your active tenant.
            </p>
          </section>
        </>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <TenantOverview tenant={t} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="core.tenant" objectId={t.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="core.tenant" objectId={t.id} />
      </DetailTab>

      <TenantDeleteDialog
        tenant={deleting}
        onOpenChange={closeDelete}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** The tenant's attributes, grouped into labelled tables — the counts that used
 * to crowd the page header. Only the name badge, slug, state and description
 * stay up top; everything else reads here. */
function TenantOverview({ tenant: t }: { tenant: Tenant }) {
  const details: KvRow[] = [
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{t.slug}</span>,
      copy: t.slug,
    },
    {
      label: "Group",
      value: t.group ? (
        t.group.name
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
    },
    {
      label: "Status",
      value: t.is_active ? (
        <Badge variant="secondary">active</Badge>
      ) : (
        <Badge variant="outline">inactive</Badge>
      ),
    },
  ]

  const scope: KvRow[] = [
    { label: "Sites", value: <span className="num">{t.site_count}</span> },
    { label: "Prefixes", value: <span className="num">{t.prefix_count}</span> },
    { label: "VLANs", value: <span className="num">{t.vlan_count}</span> },
    { label: "IPs", value: <span className="num">{t.ip_count}</span> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Details" rows={details} />
      <KvCard title="Scope" rows={scope} />
    </div>
  )
}
