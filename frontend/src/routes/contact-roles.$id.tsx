import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { ContactAssignment, ContactRole, Paginated } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { ContactRoleDeleteDialog } from "@/components/contact-role-delete-dialog"
import { buildContactAssignmentColumns } from "@/components/columns/contact-assignment-columns"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

export const Route = createFileRoute("/contact-roles/$id")({
  component: ContactRoleDetail,
})

function ContactRoleDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["contact-role", id],
    queryFn: () => api<ContactRole>(`/api/contact-roles/${id}/`),
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

function Body({ role: r }: { role: ContactRole }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "assignments" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<ContactRole | null>(null)
  const goBack = useCallback(() => nav({ to: "/contact-roles" }), [nav])

  return (
    <DetailShell
      backTo="/contact-roles"
      backLabel="Contact roles"
      title={r.name}
      presence={{ type: "contactrole", id: r.id }}
      actions={
        <>
          {canDo("contactrole", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/contact-roles/$id/edit" params={{ id: r.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("contactrole", "delete") && (
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
          subtitle={<span className="font-mono">{r.slug}</span>}
          description={r.description}
          statCols={1}
          stats={
            <DetailStat
              label="Assignments"
              value={<span className="num">{r.assignment_count}</span>}
            />
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "assignments",
          label: "Assignments",
          count: r.assignment_count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "Change log" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v)}
    >
      <DetailTab value="overview">
        <RoleOverview role={r} />
      </DetailTab>
      <DetailTab value="assignments">
        <RoleAssignmentsTable roleId={r.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.contactrole" objectId={r.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.contactrole" objectId={r.id} />
      </DetailTab>

      <ContactRoleDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function RoleOverview({ role: r }: { role: ContactRole }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && r.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{r.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: r.name, copy: r.name },
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{r.slug}</span>,
      copy: r.slug,
    },
    {
      label: "Assignments",
      value: <span className="num">{r.assignment_count}</span>,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={r.created_at} /> },
    { label: "Updated", value: <TimeCell iso={r.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Role" rows={details} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}

/** Every contact attached to something *in this role* - the impact analysis
 * you want before renaming or deleting a role. */
function RoleAssignmentsTable({ roleId }: { roleId: string }) {
  const q = useQuery({
    queryKey: ["contact-assignments", "by-role", roleId],
    queryFn: () =>
      api<Paginated<ContactAssignment>>(
        `/api/contact-assignments/?role=${roleId}&page_size=500`
      ),
  })
  // This page *is* the role, so the "role" column would repeat the title.
  const columns = useMemo<ColumnDef<ContactAssignment, unknown>[]>(
    () => buildContactAssignmentColumns({ omit: ["role"] }),
    []
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <EmptyState title="No assignments yet.">
        Nothing is attached to a contact in this role. Attach one from an
        object's Contacts tab, then pick this role there.
      </EmptyState>
    )
  return <DataTable data={rows} columns={columns} flexColumn="type" embedded />
}
