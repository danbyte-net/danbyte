import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api, type Platform } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { PlatformDeleteDialog } from "@/components/platform-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { EmbeddedDeviceTable } from "@/components/embedded-device-table"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { LifecycleBadge } from "@/components/cells/lifecycle-cell"
import { LifecycleCard } from "@/components/lifecycle-card"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/platforms/$id")({
  component: PlatformDetail,
})

function PlatformDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["platform", id],
    queryFn: () => api<Platform>(`/api/platforms/${id}/`),
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
  return <Body platform={q.data} />
}

function Body({ platform: p }: { platform: Platform }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "devices" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<Platform | null>(null)
  const goBack = useCallback(() => nav({ to: "/platforms" }), [nav])
  const { canDo, humanIds } = useMe()

  return (
    <DetailShell
      backTo="/platforms"
      backLabel="Platforms"
      title={p.name}
      presence={{ type: "platform", id: p.id }}
      actions={
        <>
          {canDo("platform", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/platforms/$id/edit" params={{ id: p.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("platform", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(p)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span className="text-2xl font-semibold tracking-tight">
                {p.name}
              </span>
              <LifecycleBadge state={p.lifecycle_state} />
            </div>
            {p.manufacturer && (
              <Link
                to="/manufacturers/$id"
                params={{ id: p.manufacturer.id }}
                className="mt-2 inline-block text-[13px] text-primary hover:underline"
              >
                {p.manufacturer.name}
              </Link>
            )}
            {p.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {p.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-1 gap-y-3 text-[13px]">
            {humanIds && p.numid != null && (
              <DetailStat
                label="Number"
                value={<span className="num font-mono">#{p.numid}</span>}
              />
            )}
            <DetailStat
              label="Devices"
              value={<span className="num">{p.device_count}</span>}
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "devices", label: "Devices", count: p.device_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="max-w-xl">
          <LifecycleCard item={p} title="OS lifecycle" />
        </div>
      </DetailTab>
      <DetailTab value="devices">
        <EmbeddedDeviceTable filter={{ platform: p.id }} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.platform" objectId={p.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.platform" objectId={p.id} />
      </DetailTab>

      <PlatformDeleteDialog
        platform={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}
