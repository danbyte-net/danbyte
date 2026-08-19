import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { useCallback, useState } from "react"

import { api } from "@/lib/api"
import type { ContactGroup } from "@/lib/api"
import { useUrlTab } from "@/lib/use-url-tab"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { TimeCell } from "@/components/cells/time-ago"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { ContactGroupDeleteDialog } from "@/components/contact-group-delete-dialog"
import {
  EmbeddedContactGroupTable,
  EmbeddedContactTable,
} from "@/components/embedded-tables"
import {
  DetailHero,
  DetailShell,
  DetailStat,
  DetailTab,
} from "@/components/detail-shell"
import { ChangeLogPanel } from "@/components/audit/change-log-panel"
import { JournalPanel } from "@/components/audit/journal-panel"

const OBJECT_TYPE = "api.contactgroup"

type Tab = "overview" | "children" | "contacts" | "journal" | "history"
const TABS: readonly Tab[] = [
  "overview",
  "children",
  "contacts",
  "journal",
  "history",
]

export const Route = createFileRoute("/contact-groups/$id")({
  component: ContactGroupDetail,
})

function ContactGroupDetail() {
  const { id } = Route.useParams()
  const q = useQuery({
    queryKey: ["contact-group", id],
    queryFn: () => api<ContactGroup>(`/api/contact-groups/${id}/`),
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

function Body({ group: g }: { group: ContactGroup }) {
  const [tab, setTab] = useUrlTab<Tab>("overview", "tab", TABS)
  const nav = useNavigate()
  const { canDo } = useMe()
  const [deleting, setDeleting] = useState<ContactGroup | null>(null)
  const goBack = useCallback(() => nav({ to: "/contact-groups" }), [nav])

  return (
    <DetailShell
      backTo="/contact-groups"
      backLabel="Contact groups"
      title={g.name}
      presence={{ type: "contactgroup", id: g.id }}
      actions={
        <>
          {canDo("contactgroup", "change") && (
            <Button variant="outline" size="sm" asChild>
              <Link to="/contact-groups/$id/edit" params={{ id: g.id }}>
                <Pencil className="h-3.5 w-3.5" /> Edit
              </Link>
            </Button>
          )}
          {canDo("contactgroup", "delete") && (
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
          // The parent is the one bit of hierarchy that belongs above the tabs:
          // it's how you walk *up* the tree, and the tabs only walk down.
          subtitle={
            g.parent ? (
              <Link
                to="/contact-groups/$id"
                params={{ id: g.parent.id }}
                className="link"
              >
                {g.parent.name}
              </Link>
            ) : (
              <span className="font-mono">{g.slug}</span>
            )
          }
          description={g.description}
          stats={
            <>
              <DetailStat
                label="Contacts"
                value={<span className="num">{g.contact_count}</span>}
              />
              <DetailStat
                label="Subgroups"
                value={<span className="num">{g.child_count}</span>}
              />
            </>
          }
        />
      }
      tabs={[
        { value: "overview", label: "Overview" },
        { value: "children", label: "Child groups", count: g.child_count },
        { value: "contacts", label: "Contacts", count: g.contact_count },
        { value: "journal", label: "Journal" },
        { value: "history", label: "History" },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <DetailTab value="overview">
        <GroupOverview group={g} />
      </DetailTab>
      <DetailTab value="children">
        <EmbeddedContactGroupTable
          filter={{ parent: g.id }}
          emptyText="No groups are nested under this one."
        />
      </DetailTab>
      <DetailTab value="contacts">
        <EmbeddedContactTable
          filter={{ group: g.id }}
          omitGroup
          emptyText="No contacts belong to this group yet."
        />
      </DetailTab>
      <DetailTab value="journal">
        <JournalPanel objectType={OBJECT_TYPE} objectId={g.id} />
      </DetailTab>
      <DetailTab value="history">
        <ChangeLogPanel objectType={OBJECT_TYPE} objectId={g.id} />
      </DetailTab>

      <ContactGroupDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={goBack}
      />
    </DetailShell>
  )
}

function GroupOverview({ group: g }: { group: ContactGroup }) {
  const { humanIds } = useMe()

  const details: KvRow[] = [
    ...(humanIds && g.numid != null
      ? [
          {
            label: "Number",
            value: <span className="num font-mono">#{g.numid}</span>,
          } satisfies KvRow,
        ]
      : []),
    { label: "Name", value: g.name, copy: g.name },
    {
      label: "Slug",
      value: <span className="font-mono text-[13px]">{g.slug}</span>,
      copy: g.slug,
    },
    {
      label: "Parent group",
      value: g.parent ? (
        <Link
          to="/contact-groups/$id"
          params={{ id: g.parent.id }}
          className="link"
        >
          {g.parent.name}
        </Link>
      ) : (
        dash
      ),
    },
    {
      label: "Description",
      value: g.description ? (
        <span className="whitespace-pre-wrap">{g.description}</span>
      ) : (
        dash
      ),
    },
  ]

  // Both counts are one hop, not the whole subtree - the same thing the tabs
  // list, so the numbers and the tables can't disagree.
  const membership: KvRow[] = [
    {
      label: "Contacts",
      value: <span className="num">{g.contact_count}</span>,
    },
    {
      label: "Child groups",
      value: <span className="num">{g.child_count}</span>,
    },
  ]

  const record: KvRow[] = [
    { label: "Created", value: <TimeCell iso={g.created_at} /> },
    { label: "Updated", value: <TimeCell iso={g.updated_at} /> },
  ]

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <KvCard title="Contact group" rows={details} />
      <KvCard title="Membership" rows={membership} />
      <KvCard title="Record" rows={record} />
    </div>
  )
}
