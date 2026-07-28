import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { CustomField, CustomFieldGroup, Paginated } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { objCan, useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { EmptyState } from "@/components/empty-state"
import { LocalityBadge } from "@/components/locality-badge"
import { QueryError } from "@/components/query-error"
import { CustomFieldGroupDeleteDialog } from "@/components/custom-field-group-delete-dialog"
import { buildCustomFieldColumns } from "@/components/columns/custom-field-columns"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/custom-field-groups/$id")({
  component: CustomFieldGroupDetail,
})

function CustomFieldGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["custom-field-group", id],
    queryFn: () => api<CustomFieldGroup>(`/api/custom-field-groups/${id}/`),
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

function Body({ group: g }: { group: CustomFieldGroup }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "fields" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const canEdit = objCan(g, "change", canDo("customfieldgroup", "change"))
  const canDelete = objCan(g, "delete", canDo("customfieldgroup", "delete"))
  const [deleting, setDeleting] = useState<CustomFieldGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/custom-field-groups" }), [nav])

  return (
    <DetailShell
      backTo="/custom-field-groups"
      backLabel="Custom field groups"
      title={g.name}
      presence={{ type: "customfieldgroup", id: g.id }}
      actions={
        <>
          {canEdit && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/custom-field-groups/$id/edit" params={{ id: g.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDelete && (
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
        <DetailHero
          title={g.name}
          badges={
            <>
              {g.collapsed && (
                <Badge variant="secondary">Starts collapsed</Badge>
              )}
              <LocalityBadge owningSite={g.owning_site} />
            </>
          }
          subtitle={<span className="font-mono">{g.slug}</span>}
          description={g.description}
          stats={
            <>
              <DetailStat
                label="Fields"
                value={<span className="num">{g.field_count}</span>}
              />
              <DetailStat
                label="Weight"
                value={<span className="num">{g.weight}</span>}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "fields", label: "Fields", count: g.field_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <GroupOverview group={g} />
      </DetailTab>
      <DetailTab value="fields">
        <GroupFieldsTable groupId={g.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel
          objectType="customization.customfieldgroup"
          objectId={g.id}
        />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel
          objectType="customization.customfieldgroup"
          objectId={g.id}
        />
      </DetailTab>

      <CustomFieldGroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function GroupOverview({ group: g }: { group: CustomFieldGroup }) {
  const details: KvRow[] = [
    { label: "Name", value: g.name, copy: g.name },
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{g.slug}</span>,
      copy: g.slug,
    },
    {
      label: "Description",
      value: g.description ? (
        <span className="whitespace-pre-wrap">{g.description}</span>
      ) : (
        dash
      ),
    },
    // Weight orders the section against other sections on a form; collapsed is
    // how it opens on a detail page. Both are presentation only — grouping
    // never changes the stored value shape.
    { label: "Weight", value: <span className="num">{g.weight}</span> },
    { label: "Starts collapsed", value: g.collapsed ? "Yes" : "No" },
    { label: "Fields", value: <span className="num">{g.field_count}</span> },
  ]

  const record: KvRow[] = [
    { label: "Locality", value: <LocalityBadge owningSite={g.owning_site} /> },
    { label: "Created", value: <TimeCell iso={g.created_at} /> },
    { label: "Updated", value: <TimeCell iso={g.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Group" rows={details} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}

/** The custom-field definitions filed under this section — what the heading
 * will actually contain on every form and detail page that renders it. */
function GroupFieldsTable({ groupId }: { groupId: string }) {
  const q = useQuery({
    queryKey: ["custom-fields", "by-group", groupId],
    queryFn: () =>
      api<Paginated<CustomField>>(
        `/api/custom-fields/?group=${groupId}&page_size=500`
      ),
  })
  // This page *is* the group, so the "group" column would repeat the title.
  const columns = useMemo<ColumnDef<CustomField, unknown>[]>(
    () => buildCustomFieldColumns({ omit: ["group"] }),
    []
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <EmptyState title="No fields in this group yet.">
        Open a custom field and pick this group on its form — the section only
        appears once something is filed under it.
      </EmptyState>
    )
  return <DataTable data={rows} columns={columns} flexColumn="label" embedded />
}
