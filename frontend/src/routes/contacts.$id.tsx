import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useUrlTab } from "@/lib/use-url-tab"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import {
  api,
  type Contact,
  type ContactAssignment,
  type Paginated,
} from "@/lib/api"
import { CONTACT_OBJECT_TYPES, contactObjectLabel } from "@/lib/contact-objects"
import { Badge } from "@/components/ui/badge"
import { TagList } from "@/components/cells/tag-list"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { KvCard, mono, dash, type KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { ContactDeleteDialog } from "@/components/contact-delete-dialog"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/contacts/$id")({
  component: ContactDetail,
})

function ContactDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["contact", id],
    queryFn: () => api<Contact>(`/api/contacts/${id}/`),
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
  return <Body contact={q.data} />
}

function Body({ contact: c }: { contact: Contact }) {
  const [tab, setTab] = useUrlTab<
    "overview" | "assignments" | "journal" | "history"
  >("overview")
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const [deleting, setDeleting] = useState<Contact | null>(null)
  const goBack = useCallback(() => nav({ to: "/contacts" }), [nav])

  const contactRows: KvRow[] = [
    ...(humanIds && c.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{c.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    {
      label: "Email",
      value: c.email ? (
        <a
          href={`mailto:${c.email}`}
          className="font-mono text-primary hover:underline"
        >
          {c.email}
        </a>
      ) : (
        dash
      ),
    },
    { label: "Phone", value: mono(c.phone) },
    {
      label: "Link",
      value: c.link ? (
        <a
          href={c.link}
          target="_blank"
          rel="noreferrer"
          className="text-primary hover:underline"
        >
          {c.link}
        </a>
      ) : (
        dash
      ),
    },
    {
      label: "Address",
      value: c.address ? (
        <span className="whitespace-pre-line">{c.address}</span>
      ) : (
        dash
      ),
    },
    {
      label: "Comments",
      value: c.comments ? (
        <span className="whitespace-pre-line">{c.comments}</span>
      ) : (
        dash
      ),
    },
  ]

  return (
    <DetailShell
      backTo="/contacts"
      backLabel="Contacts"
      title={c.name}
      presence={{ type: "contact", id: c.id }}
      actions={
        <>
          {canDo("contact", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/contacts/$id/edit" params={{ id: c.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("contact", "delete") && (
            <Button
              size="sm"
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => setDeleting(c)}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </Button>
          )}
        </>
      }
      hero={
        <section className="flex shrink-0 flex-wrap items-start gap-x-10 gap-y-4 border-b border-border px-6 py-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-2xl font-semibold tracking-tight">
                {c.name}
              </span>
              {c.title && (
                <span className="text-sm text-muted-foreground">{c.title}</span>
              )}
              {c.group && <Badge variant="secondary">{c.group.name}</Badge>}
            </div>
            {c.tags.length > 0 && (
              <div className="mt-2">
                <TagList tags={c.tags} />
              </div>
            )}
          </div>
        </section>
      }
      tabs={[
        { value: "overview", label: "Overview" },
        {
          value: "assignments",
          label: "Attached to",
          count: c.assignment_count,
        },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={(v) => setTab(v as typeof tab)}
    >
      <DetailTab value="overview">
        <div className="grid gap-6 lg:grid-cols-2">
          <KvCard title="Contact" rows={contactRows} />
        </div>
      </DetailTab>
      <DetailTab value="assignments">
        <ContactAssignmentsTable contactId={c.id} />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType="api.contact" objectId={c.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType="api.contact" objectId={c.id} />
      </DetailTab>

      <ContactDeleteDialog
        contact={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function ContactAssignmentsTable({ contactId }: { contactId: string }) {
  const q = useQuery({
    queryKey: ["contact-assignments", "by-contact", contactId],
    queryFn: () =>
      api<Paginated<ContactAssignment>>(
        `/api/contact-assignments/?contact=${contactId}&page_size=500`
      ),
  })
  const columns = useMemo<ColumnDef<ContactAssignment>[]>(
    () => [
      {
        id: "object",
        header: "Object",
        enableSorting: false,
        cell: ({ row }) => {
          const t = CONTACT_OBJECT_TYPES[row.original.object_type]
          return t?.route ? (
            <Link
              to={t.route}
              params={{ id: row.original.object_id }}
              className="font-mono font-medium hover:underline"
            >
              {row.original.object_id.slice(0, 8)}
            </Link>
          ) : (
            <span className="font-mono">
              {row.original.object_id.slice(0, 8)}
            </span>
          )
        },
      },
      {
        id: "type",
        accessorFn: (a) => contactObjectLabel(a.object_type),
        header: "Type",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {contactObjectLabel(row.original.object_type)}
          </span>
        ),
      },
      {
        id: "role",
        header: "Role",
        enableSorting: false,
        cell: ({ row }) =>
          row.original.role ? (
            <span className="text-xs">{row.original.role.name}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "priority",
        accessorKey: "priority",
        header: "Priority",
        cell: ({ row }) => (
          <span className="text-xs capitalize">
            {row.original.priority_display}
          </span>
        ),
      },
    ],
    []
  )

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        This contact isn't attached to anything yet.
      </p>
    )
  return <DataTable data={rows} columns={columns} flexColumn="type" embedded />
}
