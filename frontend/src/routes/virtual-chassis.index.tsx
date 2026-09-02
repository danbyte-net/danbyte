import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type {
  BulkStatusEntry,
  BulkStatusResponse,
  Paginated,
  StatusMini,
  VirtualChassis,
} from "@/lib/api"
import { MixedStatusBadge } from "@/components/monitoring/mixed-status-badge"
import { StatusBadge } from "@/components/status-badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { RowActions } from "@/components/row-actions"
import { VirtualChassisDeleteDialog } from "@/components/virtual-chassis-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/virtual-chassis/")({
  component: VirtualChassisPage,
})

function VirtualChassisPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("virtualchassis", "add")
  const canEdit = canDo("virtualchassis", "change")
  const canDelete = canDo("virtualchassis", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<VirtualChassis | null>(null)

  const query = useQuery({
    queryKey: ["virtual-chassis", q],
    queryFn: () =>
      api<Paginated<VirtualChassis>>(
        `/api/virtual-chassis/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  // One bulk request for every member device on the page; each chassis row
  // then merges its members' rollups (counts summed - the racing-flag badge
  // derives the read from them).
  const memberIds = useMemo(
    () => [...new Set(rows.flatMap((v) => v.members.map((m) => m.id)))],
    [rows]
  )
  const monQuery = useQuery({
    queryKey: ["vc-mon-status", memberIds],
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ devices: memberIds }),
      }),
    enabled: memberIds.length > 0,
  })
  const monByDevice = monQuery.data?.statuses
  const onDelete = useCallback((v: VirtualChassis) => setDeleting(v), [])
  const columns = useMemo<ColumnDef<VirtualChassis>[]>(
    () => [
      ...(humanIds
        ? [numidColumn<VirtualChassis>({ get: (r) => r.numid })]
        : []),
      {
        id: "name",
        accessorKey: "name",
        header: ({ column }) => <SortHeader column={column} label="Name" />,
        cell: ({ row }) => (
          <Link
            to="/virtual-chassis/$id"
            params={{ id: row.original.id }}
            className="link font-medium"
          >
            {row.original.name}
          </Link>
        ),
      },
      {
        id: "domain",
        accessorKey: "domain",
        header: "Domain",
        cell: ({ row }) =>
          row.original.domain ? (
            <span className="font-mono text-xs">{row.original.domain}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "master",
        accessorFn: (v) => v.master?.name ?? "",
        header: "Master",
        cell: ({ row }) =>
          row.original.master ? (
            <Link
              to="/devices/$id"
              params={{ id: row.original.master.id }}
              className="link font-mono text-xs"
            >
              {row.original.master.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "members",
        accessorKey: "member_count",
        header: ({ column }) => <SortHeader column={column} label="Members" />,
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.member_count}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Members",
            get: (r: VirtualChassis) => (r.member_count > 0 ? "in" : "out"),
            formatValue: (v) => ({
              label: v === "in" ? "Has members" : "Empty",
            }),
          },
        },
      },
      {
        id: "status",
        // The members' distinct statuses, so uniform stacks sort together.
        accessorFn: (r) => stackStatus(r),
        header: ({ column }) => <SortHeader column={column} label="Status" />,
        cell: ({ row }) => (
          <MemberStatusCell members={row.original.members} />
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: VirtualChassis) => stackStatus(r),
            // One uniform status keeps its colour; a mixed stack lists them.
            formatValue: (v, sample) => {
              const s = sample.members.find((m) => m.status?.name === v)?.status
              return {
                label: v || "No status",
                color: s?.color,
                textColor: s?.text_color ?? undefined,
              }
            },
          },
        },
      },
      {
        id: "monitoring",
        header: "Monitoring",
        enableSorting: false,
        cell: ({ row }) => {
          const merged = mergeRollups(
            row.original.members.map((m) => monByDevice?.[m.id])
          )
          if (!merged) return <span className="text-muted-foreground">-</span>
          return <MixedStatusBadge counts={merged} />
        },
      },
      {
        id: "primary_ip",
        accessorFn: (v) => v.primary_ip?.ip_address ?? "",
        header: "Primary IP",
        cell: ({ row }) =>
          row.original.primary_ip ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.primary_ip.id }}
              className="link font-mono text-xs"
            >
              {row.original.primary_ip.ip_address}
            </Link>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "oob_ip",
        accessorFn: (v) => v.oob_ip?.ip_address ?? "",
        header: "OOB IP",
        cell: ({ row }) =>
          row.original.oob_ip ? (
            <Link
              to="/ips/$id"
              params={{ id: row.original.oob_ip.id }}
              className="link font-mono text-xs"
            >
              {row.original.oob_ip.ip_address}
            </Link>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      tagsColumn<VirtualChassis>({ getTags: (r) => r.tags ?? [] }),
      {
        id: "description",
        accessorKey: "description",
        header: "Description",
        cell: ({ row }) => (
          <span className="block whitespace-nowrap text-muted-foreground">
            {row.original.description || "-"}
          </span>
        ),
      },
      timeAgoColumn<VirtualChassis>({
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
            editTo={canEdit ? "/virtual-chassis/$id/edit" : undefined}
            editParams={{ id: row.original.id }}
            onDelete={canDelete ? () => onDelete(row.original) : undefined}
          />
        ),
      },
    ],
    [monByDevice, onDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows, snapshot, restore, activeCount, columns: facetColumns } =
    useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Virtual chassis"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "virtualchassis",
        filters: { snapshot, restore, activeCount },
      }}
      search={{ value: q, onChange: setQ, placeholder: "Filter by name…" }}
      actions={
        <>
          <TableActions ioType="virtualchassis" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/virtual-chassis/new">Add virtual chassis</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={facetColumns}
        flexColumn="description"
        tableId="virtual-chassis"
      />
      <VirtualChassisDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}


/** Sum member rollups; null when nothing is monitored. */
function mergeRollups(
  entries: Array<BulkStatusEntry | undefined>
): Partial<Record<string, number>> | null {
  const counts = new Map<string, number>()
  for (const e of entries) {
    for (const [k, n] of Object.entries(e?.counts ?? {})) {
      if (n) counts.set(k, (counts.get(k) ?? 0) + n)
    }
  }
  return counts.size > 0 ? Object.fromEntries(counts) : null
}

/** The members' lifecycle statuses, combined: one badge when they all agree,
 * a racing-flag split of the distinct status colors when they don't. */
/** The stack's status as one string: a single status when every member
 * agrees, the distinct ones joined when they don't, "" for none. */
function stackStatus(r: VirtualChassis): string {
  return [...new Set(r.members.map((m) => m.status?.name ?? ""))]
    .filter(Boolean)
    .sort()
    .join(", ")
}

function MemberStatusCell({
  members,
}: {
  members: VirtualChassis["members"]
}) {
  const present: { status: StatusMini; n: number }[] = []
  for (const m of members) {
    if (!m.status) continue
    const hit = present.find((p) => p.status.id === m.status!.id)
    if (hit) hit.n += 1
    else present.push({ status: m.status, n: 1 })
  }
  if (present.length === 0)
    return <span className="text-muted-foreground">-</span>
  if (present.length === 1) return <StatusBadge status={present[0].status} />
  const slice = 100 / present.length
  const stops = present
    .map(
      (p, i) =>
        `${p.status.color || "#a1a1aa"} ${i * slice}% ${(i + 1) * slice}%`
    )
    .join(", ")
  const title = present.map((p) => `${p.n} ${p.status.name}`).join(" · ")
  return (
    <span
      title={title}
      aria-label={title}
      className="inline-block h-5 w-8 rounded-[5px] align-middle ring-1 ring-black/10 ring-inset dark:ring-white/15"
      style={{ backgroundImage: `linear-gradient(to top right, ${stops})` }}
    />
  )
}
