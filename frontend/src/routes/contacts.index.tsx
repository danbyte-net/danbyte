import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { type Contact } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildContactColumns } from "@/components/columns/contact-columns"
import {
  FilterRail,
  FacetGroup,
  tagObjectsLink,
  type FacetOption,
} from "@/components/filter-rail"
import { ContactDeleteDialog } from "@/components/contact-delete-dialog"
import { useMe } from "@/lib/use-me"
import { useUrlSearch, toggled, useKnown, useUrlSet } from "@/lib/url-filters"

export const Route = createFileRoute("/contacts/")({ component: ContactsPage })

function ContactsPage() {
  const [q, setQ] = useUrlSearch()
  const [groupFilterRaw, setGroupFilter] = useUrlSet("group")
  const [tagFilterRaw, setTagFilter] = useUrlSet("tag")
  const [deleting, setDeleting] = useState<Contact | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("contact", "add")
  const canEdit = canDo("contact", "change")
  const canDelete = canDo("contact", "delete")

  const query = useQuery({
    queryKey: ["contacts", q],
    queryFn: () =>
      apiAll<Contact>(
        `/api/contacts/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const allRows = query.data?.results ?? []

  const facets = useMemo(() => {
    const groups: Record<string, { name: string; count: number }> = {}
    const tags: Record<
      string,
      {
        id: number
        name: string
        color?: string
        textColor?: string
        count: number
      }
    > = {}
    for (const cn of allRows) {
      const gk = cn.group?.id ?? "__none__"
      if (!groups[gk])
        groups[gk] = { name: cn.group?.name ?? "No group", count: 0 }
      groups[gk].count++
      for (const t of cn.tags) {
        if (!tags[t.slug])
          tags[t.slug] = {
            id: t.id,
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
          link: tagObjectsLink(v.id),
        })),
    }
  }, [allRows])
  // A value no row carries (a stale link) is ignored.
  const groupFilter = useKnown(groupFilterRaw, facets.groups)
  const tagFilter = useKnown(tagFilterRaw, facets.tags)
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

  const handleDelete = useCallback((cn: Contact) => setDeleting(cn), [])
  const columns = useMemo<ColumnDef<Contact>[]>(
    () =>
      buildContactColumns({
        humanIds,
        selection: true,
        // Tag chips drive the same rail facet, so clicking one filters instead
        // of being decorative (it was inert before the factory).
        tagFilter: {
          activeSlugs: tagFilter,
          onToggle: (v) => setTagFilter((s) => toggled(s, v)),
        },
        actions: {
          editTo: canEdit ? "/contacts/$id/edit" : undefined,
          editParams: (c) => ({ id: c.id }),
          onDelete: canDelete ? handleDelete : undefined,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds, tagFilter]
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
            onToggle={(v) => setGroupFilter((s) => toggled(s, v))}
          />
          <FacetGroup
            label="Tags"
            options={facets.tags}
            selected={tagFilter}
            onToggle={(v) => setTagFilter((s) => toggled(s, v))}
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
        initialColumnVisibility={{ hours: false, available: false }}
        tableId="contacts"
      />
      <ContactDeleteDialog
        contact={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
