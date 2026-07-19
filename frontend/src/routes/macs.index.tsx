import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useMemo, useState } from "react"

import { api, type MacEntry, type Tag } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { TagList } from "@/components/cells/tag-list"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { MacObjectDialog } from "@/components/mac-object-dialog"
import { useMe } from "@/lib/use-me"

interface MacList {
  count: number
  results: MacEntry[]
}

export const Route = createFileRoute("/macs/")({ component: MacsPage })

function MacsPage() {
  const { canDo } = useMe()
  const canAdd = canDo("macaddress", "add")
  const [q, setQ] = useState("")
  const [adding, setAdding] = useState(false)

  const query = useQuery({
    queryKey: ["macs"],
    queryFn: () => api<MacList>("/api/macs/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return allRows
    return allRows.filter((m) => {
      if (m.mac.toLowerCase().includes(needle)) return true
      if (
        m.interfaces.some(
          (i) =>
            i.name.toLowerCase().includes(needle) ||
            i.device.name.toLowerCase().includes(needle)
        )
      )
        return true
      if (m.objects.some((o) => o.description.toLowerCase().includes(needle)))
        return true
      return m.ips.some((ip) => ip.ip_address.toLowerCase().includes(needle))
    })
  }, [allRows, q])

  const columns = useMemo<ColumnDef<MacEntry>[]>(() => buildColumns(), [])
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="MAC addresses"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by MAC, device, interface, IP…",
      }}
      actions={
        canAdd && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add MAC
          </Button>
        )
      }
      query={query}
    >
      {filteredRows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No MAC addresses yet — set a MAC on an interface, or pair one with an
          IP, and it shows up here.
        </p>
      ) : (
        <DataTable
          data={filteredRows}
          columns={columns}
          flexColumn="description"
        />
      )}
      <MacObjectDialog open={adding} onOpenChange={setAdding} />
    </ListPageShell>
  )
}

/** All distinct non-empty object descriptions, joined — so a row that matched a
 * search on any object's description always shows the matched text. */
function allDescriptions(m: MacEntry): string {
  const seen = new Set<string>()
  for (const o of m.objects) if (o.description) seen.add(o.description)
  return [...seen].join(" · ")
}

/** Union of tags across a MAC's objects, de-duplicated by id. */
function unionTags(m: MacEntry): Tag[] {
  const seen = new Map<number, Tag>()
  for (const o of m.objects) for (const t of o.tags) seen.set(t.id, t)
  return [...seen.values()]
}

function buildColumns(): ColumnDef<MacEntry>[] {
  return [
    {
      id: "mac",
      header: "MAC address",
      cell: ({ row }) => (
        <Link
          to="/macs/$mac"
          params={{ mac: row.original.mac }}
          className="font-mono text-[13px] font-medium hover:underline"
        >
          {row.original.mac}
        </Link>
      ),
    },
    {
      id: "interfaces",
      header: "Interfaces",
      cell: ({ row }) => {
        const ifs = row.original.interfaces
        if (ifs.length === 0)
          return <span className="text-muted-foreground">—</span>
        return (
          <div className="flex flex-wrap items-center gap-1">
            {ifs.map((i) => (
              <Link
                key={i.id}
                to="/interfaces/$id"
                params={{ id: i.id }}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:underline"
              >
                {i.device.name}:{i.name}
              </Link>
            ))}
          </div>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Interface",
          get: (r: MacEntry) => (r.interfaces.length > 0 ? "yes" : "no"),
          formatValue: (v) => ({
            label: v === "yes" ? "Has interface" : "No interface",
          }),
        },
      },
    },
    {
      id: "ips",
      header: "Paired IPs",
      cell: ({ row }) => {
        const ips = row.original.ips
        if (ips.length === 0)
          return <span className="text-muted-foreground">—</span>
        return (
          <div className="flex flex-wrap items-center gap-1">
            {ips.map((ip) => (
              <Link
                key={ip.id}
                to="/ips/$id"
                params={{ id: ip.id }}
                className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[11px] hover:underline"
              >
                {ip.ip_address}
              </Link>
            ))}
          </div>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "IP",
          get: (r: MacEntry) => (r.ips.length > 0 ? "yes" : "no"),
          formatValue: (v) => ({
            label: v === "yes" ? "Has IP" : "No IP",
          }),
        },
      },
    },
    {
      id: "tags",
      header: "Tags",
      cell: ({ row }) => {
        const tags = unionTags(row.original)
        if (tags.length === 0)
          return <span className="text-muted-foreground">—</span>
        return <TagList tags={tags} inline />
      },
    },
    {
      id: "description",
      header: "Description",
      accessorFn: (r) => allDescriptions(r),
      cell: ({ row }) => {
        const desc = row.getValue<string>("description")
        return desc ? (
          <span className="text-[13px]">{desc}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "MAC object",
          get: (r: MacEntry) => (r.objects.length > 0 ? "yes" : "no"),
          formatValue: (v) => ({
            label: v === "yes" ? "Has object" : "No object",
          }),
        },
      },
    },
  ]
}
