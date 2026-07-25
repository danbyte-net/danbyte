import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Tag, type TagUsage, type TagUsageItem } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { DataTable, SortHeader } from "@/components/data-table"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import {
  LocalityBadge,
  PromoteToGlobalButton,
} from "@/components/locality-badge"
import { QueryError } from "@/components/query-error"
import { TagDeleteDialog } from "@/components/tag-delete-dialog"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/tags/$id")({ component: TagDetail })

function TagDetail() {
  const { id } = Route.useParams()
  const tag = useQuery({
    queryKey: ["tag", id],
    queryFn: () => api<Tag>(`/api/tags/${id}/`),
  })
  if (tag.isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (tag.isError)
    return (
      <div className="p-6">
        <QueryError error={tag.error} />
      </div>
    )
  if (!tag.data) return null
  return <TagDetailBody tag={tag.data} />
}

function TagDetailBody({ tag: t }: { tag: Tag }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "objects" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo, editableSites } = useMe()
  const canPromote =
    !!t.owning_site && editableSites === "all" && canDo("tag", "change")
  const [deleting, setDeleting] = useState<Tag | null>(null)
  const goBack = useCallback(() => nav({ to: "/tags" }), [nav])
  const usage = t.usage_count ?? 0

  return (
    <DetailShell
      backTo="/tags"
      backLabel="Tags"
      title={t.name}
      presence={{ type: "tag", id: String(t.id) }}
      actions={
        <>
          <Button variant="outline" size="sm" asChild>
            <Link to="/tags/$id/edit" params={{ id: String(t.id) }}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Link>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => setDeleting(t)}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </Button>
        </>
      }
      hero={
        <DetailHero
          title={<ColorBadge name={t.name} color={t.color || undefined} />}
          badges={
            <>
              <LocalityBadge owningSite={t.owning_site} />
              {canPromote && (
                <PromoteToGlobalButton
                  url={`/api/tags/${t.id}/promote/`}
                  name={t.name}
                  invalidate={[
                    ["tags"],
                    ["tags-picker"],
                    ["tag", String(t.id)],
                  ]}
                />
              )}
            </>
          }
          stats={
            <DetailStat
              label="Used by"
              value={
                <span className="num">
                  {usage} object{usage === 1 ? "" : "s"}
                </span>
              }
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "objects", label: "Tagged objects", count: usage },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <TagOverview tag={t} />
      </DetailTab>
      <DetailTab value="objects">
        <TagUsageTable tagId={t.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="core.tag" objectId={String(t.id)} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="core.tag" objectId={String(t.id)} />
      </DetailTab>

      <TagDeleteDialog
        tag={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

/** Tag attributes that used to crowd the header, grouped into a table. Only the
 * colored name badge, locality and usage count stay up top. */
function TagOverview({ tag: t }: { tag: Tag }) {
  const details: KvRow[] = [
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{t.slug}</span>,
      copy: t.slug,
    },
    {
      label: "Color",
      value: t.color ? (
        <span className="inline-flex items-center gap-1.5">
          <span
            className="h-3 w-3 rounded-sm border border-border"
            style={{ backgroundColor: t.color }}
          />
          <span className="font-mono">{t.color}</span>
        </span>
      ) : (
        dash
      ),
      copy: t.color || undefined,
    },
    {
      label: "Scoped to",
      value: t.owning_site ? (
        <Link
          to="/sites/$id"
          params={{ id: t.owning_site.id }}
          className="text-primary hover:underline"
        >
          {t.owning_site.name}
        </Link>
      ) : (
        <span className="text-muted-foreground">Whole tenant</span>
      ),
    },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Tag" rows={details} />
    </div>
  )
}

function TagUsageTable({ tagId }: { tagId: number }) {
  const q = useQuery({
    queryKey: ["tag-usage", tagId],
    queryFn: () => api<TagUsage>(`/api/tags/${tagId}/usage/`),
  })
  const columns = useMemo<ColumnDef<TagUsageItem>[]>(
    () => [
      {
        id: "type",
        accessorKey: "type_label",
        header: ({ column }) => <SortHeader column={column} label="Type" />,
        cell: ({ row }) => (
          <Badge variant="secondary">{row.original.type_label}</Badge>
        ),
      },
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Object" />,
        // Plain anchor: the target route varies by object type, so we let the
        // browser resolve the concrete path rather than thread typed Links.
        cell: ({ row }) => (
          <a
            href={row.original.url}
            className="font-mono text-[13px] hover:underline"
          >
            {row.original.name}
          </a>
        ),
      },
    ],
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No objects in this tenant carry this tag yet.
      </p>
    )
  }
  return <DataTable data={rows} columns={columns} flexColumn="name" embedded />
}
