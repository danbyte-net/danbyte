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
import { Badge } from "@/components/ui/badge"
import { TagList } from "@/components/cells/tag-list"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildContactAssignmentColumns } from "@/components/columns/contact-assignment-columns"
import { DetailHero, DetailShell, DetailTab } from "@/components/detail-shell"
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
        <DetailHero
          title={c.name}
          badges={
            <>
              {c.title && (
                <span className="text-sm text-muted-foreground">{c.title}</span>
              )}
              {/* The group now has a page of its own — the badge is the way
                  back up to "who else is in this team". */}
              {c.group && (
                <Link to="/contact-groups/$id" params={{ id: c.group.id }}>
                  <Badge variant="secondary" className="hover:underline">
                    {c.group.name}
                  </Badge>
                </Link>
              )}
            </>
          }
          tags={c.tags.length > 0 && <TagList tags={c.tags} />}
        />
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
  // This page *is* the contact, so the "contact" column would repeat the title.
  const columns = useMemo<ColumnDef<ContactAssignment, unknown>[]>(
    () => buildContactAssignmentColumns({ omit: ["contact", "updated"] }),
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
