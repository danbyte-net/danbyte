import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import {
  api,
  type Paginated,
  type Platform,
  type PlatformGroup,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import { PlatformGroupDeleteDialog } from "@/components/platform-group-delete-dialog"
import { DetailShell, DetailStat, DetailTab } from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { KvCard, dash, mono, type KvRow } from "@/components/kv-card"
import { EmptyState } from "@/components/empty-state"
import { LifecycleFlag } from "@/components/cells/lifecycle-cell"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/platform-groups/$id")({
  component: PlatformGroupDetail,
})

function PlatformGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["platform-group", id],
    queryFn: () => api<PlatformGroup>(`/api/platform-groups/${id}/`),
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
  return <Body group={q.data} />
}

function Body({ group: g }: { group: PlatformGroup }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "platforms" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const [deleting, setDeleting] = useState<PlatformGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/platform-groups" }), [nav])
  const { canDo, humanIds } = useMe()

  const children = useQuery({
    queryKey: ["platform-groups", "children", g.id],
    queryFn: () =>
      api<Paginated<PlatformGroup>>("/api/platform-groups/?page_size=200"),
    select: (data) => data.results.filter((c) => c.parent?.id === g.id),
  })

  const rows: KvRow[] = [
    { label: "Name", value: g.name, copy: g.name },
    { label: "Slug", value: mono(g.slug), copy: g.slug },
    {
      label: "Parent group",
      value: g.parent ? (
        <Link
          to="/platform-groups/$id"
          params={{ id: g.parent.id }}
          className="text-primary hover:underline"
        >
          {g.parent.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Subgroups",
      value: children.data?.length ? (
        <span className="flex flex-wrap gap-x-3 gap-y-1">
          {children.data.map((c) => (
            <Link
              key={c.id}
              to="/platform-groups/$id"
              params={{ id: c.id }}
              className="text-primary hover:underline"
            >
              {c.name}
            </Link>
          ))}
        </span>
      ) : (
        dash
      ),
    },
    { label: "Description", value: g.description || dash },
  ]

  return (
    <DetailShell
      backTo="/platform-groups"
      backLabel="Platform groups"
      title={g.name}
      presence={{ type: "platformgroup", id: g.id }}
      actions={
        <>
          {canDo("platformgroup", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/platform-groups/$id/edit" params={{ id: g.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("platformgroup", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(g)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <span className="text-2xl font-semibold tracking-tight">
              {g.name}
            </span>
            {g.parent && (
              <Link
                to="/platform-groups/$id"
                params={{ id: g.parent.id }}
                className="mt-2 block text-[13px] text-primary hover:underline"
              >
                {g.parent.name}
              </Link>
            )}
            {g.description && (
              <p className="mt-3 max-w-2xl text-[13px] text-muted-foreground">
                {g.description}
              </p>
            )}
          </div>
          <dl className="ml-auto grid grid-cols-1 gap-y-3 text-[13px]">
            {humanIds && g.numid != null && (
              <DetailStat
                label="Number"
                value={<span className="num font-mono">#{g.numid}</span>}
              />
            )}
            <DetailStat
              label="Platforms"
              value={<span className="num">{g.platform_count}</span>}
            />
            <DetailStat
              label="Subgroups"
              value={<span className="num">{g.child_count}</span>}
            />
          </dl>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "platforms", label: "Platforms", count: g.platform_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="max-w-xl">
          <KvCard title="Platform group" rows={rows} />
        </div>
      </DetailTab>
      <DetailTab value="platforms">
        <GroupPlatforms groupId={g.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.platformgroup" objectId={g.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.platformgroup" objectId={g.id} />
      </DetailTab>

      <PlatformGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function GroupPlatforms({ groupId }: { groupId: string }) {
  const q = useQuery({
    queryKey: ["platforms", "group", groupId],
    queryFn: () =>
      api<Paginated<Platform>>(
        `/api/platforms/?${new URLSearchParams({ group: groupId }).toString()}`
      ),
  })
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (!rows.length)
    return (
      <EmptyState title="No platforms">
        No platforms belong to this group yet — set the group on a platform.
      </EmptyState>
    )
  return (
    <ul className="max-w-xl divide-y divide-border rounded-lg border border-border">
      {rows.map((p) => (
        <li
          key={p.id}
          className="flex items-center justify-between gap-3 px-4 py-2.5"
        >
          <span className="inline-flex items-center gap-2">
            <Link
              to="/platforms/$id"
              params={{ id: p.id }}
              className="text-[13px] font-medium text-primary hover:underline"
            >
              {p.name}
            </Link>
            <LifecycleFlag state={p.lifecycle_state} />
          </span>
          <span className="num text-xs text-muted-foreground">
            {p.device_count} device{p.device_count === 1 ? "" : "s"}
          </span>
        </li>
      ))}
    </ul>
  )
}
