import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Contact, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ContactDeleteDialog } from "@/components/contact-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/contacts/")({ component: ContactsPage })

function ContactsPage() {
  const [q, setQ] = useState("")
  const [groupFilter, setGroupFilter] = useState<Set<string>>(new Set())
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<Contact | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("contact", "add")
  const canEdit = canDo("contact", "change")
  const canDelete = canDo("contact", "delete")

  const query = useQuery({
    queryKey: ["contacts", q],
    queryFn: () =>
      api<Paginated<Contact>>(
        `/api/contacts/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    return allRows.filter((cn) => {
      if (groupFilter.size > 0) {
        const key = cn.group?.id ?? "__none__"
        if (!groupFilter.has(key)) return false
      }
      if (tagFilter.size > 0 && !cn.tags.some((t) => tagFilter.has(t.slug)))
        return false
      return true
    })
  }, [allRows, groupFilter, tagFilter])

  const facets = useMemo(() => {
    const groups: Record<string, { name: string; count: number }> = {}
    const tags: Record<
      string,
      { name: string; color?: string; textColor?: string; count: number }
    > = {}
    for (const cn of allRows) {
      const gk = cn.group?.id ?? "__none__"
      if (!groups[gk])
        groups[gk] = { name: cn.group?.name ?? "No group", count: 0 }
      groups[gk].count++
      for (const t of cn.tags) {
        if (!tags[t.slug])
          tags[t.slug] = {
            name: t.name,
            color: t.color,
            textColor: t.text_color,
            count: 0,
          }
        tags[t.slug].count++
      }
    }
    return {
      groups: Object.entries(groups)
        .sort(([, a], [, b]) => b.count - a.count)
        .map<FacetOption>(([id, v]) => ({
          value: id,
          label: v.name,
          count: v.count,
        })),
      tags: Object.entries(tags)
        .sort(([, a], [, b]) => b.count - a.count)
        .map<FacetOption>(([slug, v]) => ({
          value: slug,
          label: v.name,
          count: v.count,
          color: v.color,
          textColor: v.textColor,
        })),
    }
  }, [allRows])

  const handleDelete = useCallback((cn: Contact) => setDeleting(cn), [])
  const columns = useMemo<ColumnDef<Contact>[]>(
    () =>
      buildColumns({ onDelete: handleDelete, canEdit, canDelete, humanIds }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Contacts"
      count={query.data ? rows.length : undefined}
      rail={
        <FilterRail>
          <FacetGroup
            label="Group"
            options={facets.groups}
            selected={groupFilter}
            onToggle={(v) => toggleInSet(groupFilter, v, setGroupFilter)}
          />
          <FacetGroup
            label="Tags"
            options={facets.tags}
            selected={tagFilter}
            onToggle={(v) => toggleInSet(tagFilter, v, setTagFilter)}
          />
        </FilterRail>
      }
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, title, email…",
      }}
      actions={
        <>
          <TableActions ioType="contact" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/contacts/new">Add contact</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="title"
        tableId="contacts"
      />
      <ContactDeleteDialog
        contact={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (c: Contact) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<Contact>[] {
  return [
    selectionColumn<Contact>(),
    ...(humanIds ? [numidColumn<Contact>({ get: (r) => r.numid })] : []),
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/contacts/$id"
          params={{ id: row.original.id }}
          className="font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "title",
      accessorKey: "title",
      header: "Title",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.title || "—"}
        </span>
      ),
    },
    {
      id: "email",
      accessorKey: "email",
      header: ({ column }) => <SortHeader column={column} label="Email" />,
      cell: ({ row }) =>
        row.original.email ? (
          <a
            href={`mailto:${row.original.email}`}
            className="font-mono text-xs text-primary hover:underline"
          >
            {row.original.email}
          </a>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "phone",
      accessorKey: "phone",
      header: "Phone",
      cell: ({ row }) =>
        row.original.phone ? (
          <span className="font-mono text-xs">{row.original.phone}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "group",
      accessorFn: (c) => c.group?.name ?? "",
      header: "Group",
      cell: ({ row }) =>
        row.original.group ? (
          <span className="text-xs">{row.original.group.name}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "assignments",
      accessorKey: "assignment_count",
      header: ({ column }) => <SortHeader column={column} label="Attached" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.assignment_count}</span>
      ),
    },
    tagsColumn<Contact>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    timeAgoColumn<Contact>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/contacts/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
        />
      ),
    },
  ]
}
