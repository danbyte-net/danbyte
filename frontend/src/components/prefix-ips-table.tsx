import { memo, useCallback, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ColumnDef } from "@tanstack/react-table"

import {
  api,
  type BulkStatusEntry,
  type BulkStatusResponse,
  type CustomField,
  type IPAddress,
  type IPListResponse,
  type IPRange,
  type Paginated,
} from "@/lib/api"
import { objCan } from "@/lib/use-me"
import { ipToBigInt, bigIntToIp, enumerableHostInts } from "@/lib/prefix-tree"
import { MixedStatusBadge } from "@/components/monitoring/mixed-status-badge"
import { DataTable } from "@/components/data-table"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { dash } from "@/components/cells/dash"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { useCustomFieldDefs } from "@/components/custom-field-display"
import { QueryError } from "@/components/query-error"
import { RoleChip } from "@/components/role-chip"
import { Button } from "@/components/ui/button"
import { RowActions } from "@/components/row-actions"

// Synthetic row union — real registered IPs interleaved with placeholders
// for free addresses when "Show available" is on.
export type IpRow =
  | { kind: "registered"; ip: IPAddress }
  | { kind: "free"; address: string }

// Stable empty fallback so `columns` (which depends on `monitoring`) keeps a
// constant identity while the bulk status query loads.
const EMPTY_MON: Record<string, BulkStatusEntry> = {}

interface PrefixIpsTableProps {
  prefixId: string
  // Active filter sets — table calls back when a tag/etc gets toggled inline.
  statusFilter: Set<string>
  roleFilter: Set<string>
  tagFilter: Set<string>
  onToggleTag: (slug: string) => void
  search: string
  showAvailable: boolean
  /** The prefix CIDR — needed to enumerate free host addresses. */
  cidr: string
  hasDescendants: boolean
  onEdit: (ip: IPAddress) => void
  onDelete: (ip: IPAddress) => void
  onCreateAt: (address: string) => void
  onSelectedRowsChange: (rows: IPAddress[]) => void
  canEdit: boolean
  canDelete: boolean
  canAdd: boolean
}

function PrefixIpsTableImpl({
  prefixId,
  statusFilter,
  roleFilter,
  tagFilter,
  onToggleTag,
  search,
  showAvailable,
  cidr,
  hasDescendants,
  onEdit,
  onDelete,
  onCreateAt,
  onSelectedRowsChange,
  canEdit,
  canDelete,
  canAdd,
}: PrefixIpsTableProps) {
  const query = useQuery({
    queryKey: ["prefix-ips", prefixId],
    queryFn: () => api<IPListResponse>(`/api/prefixes/${prefixId}/ips/`),
  })

  const rows = useMemo<IpRow[]>(() => {
    const all = query.data?.results ?? []
    const q = search.trim().toLowerCase()
    const filtered = all.filter((ip) => {
      if (
        statusFilter.size > 0 &&
        (!ip.status || !statusFilter.has(ip.status.id))
      )
        return false
      if (roleFilter.size > 0 && (!ip.role || !roleFilter.has(ip.role.id)))
        return false
      if (tagFilter.size > 0 && !ip.tags.some((t) => tagFilter.has(t.slug)))
        return false
      if (q) {
        const haystack =
          ip.ip_address +
          " " +
          (ip.description || "") +
          " " +
          (ip.assigned_device?.name || "") +
          " " +
          (ip.reservation_note || "")
        if (!haystack.toLowerCase().includes(q)) return false
      }
      return true
    })
    const registeredRows: IpRow[] = filtered.map((ip) => ({
      kind: "registered",
      ip,
    }))

    // "Show available": fill in the unregistered hosts as ghost rows. Only when
    // no status/role/tag filter is active (free addresses have none) and the
    // prefix is small enough to enumerate (≤ cap → null = too big, e.g. a /64).
    const freeRows: IpRow[] = []
    if (
      showAvailable &&
      statusFilter.size === 0 &&
      roleFilter.size === 0 &&
      tagFilter.size === 0
    ) {
      const hosts = enumerableHostInts(cidr)
      if (hosts) {
        const taken = new Set<bigint>()
        for (const ip of all) {
          const b = ipToBigInt(ip.ip_address)
          if (b !== null) taken.add(b)
        }
        for (const n of hosts.ints) {
          if (taken.has(n)) continue
          const address = bigIntToIp(n, hosts.family)
          if (q && !address.toLowerCase().includes(q)) continue
          freeRows.push({ kind: "free", address })
        }
      }
    }

    const merged = [...registeredRows, ...freeRows]
    // Default to numeric address order so registered + free interleave.
    const addrInt = (r: IpRow) =>
      r.kind === "registered"
        ? (ipToBigInt(r.ip.ip_address) ?? 0n)
        : (ipToBigInt(r.address) ?? 0n)
    merged.sort((a, b) => {
      const av = addrInt(a)
      const bv = addrInt(b)
      return av < bv ? -1 : av > bv ? 1 : 0
    })
    return merged
  }, [
    query.data,
    statusFilter,
    roleFilter,
    tagFilter,
    search,
    showAvailable,
    cidr,
  ])

  // Monitoring status for the registered IPs in view (bulk, decoupled query).
  const ipIds = useMemo(
    () =>
      rows
        .filter(
          (r): r is Extract<IpRow, { kind: "registered" }> =>
            r.kind === "registered"
        )
        .map((r) => r.ip.id),
    [rows]
  )
  const monQuery = useQuery({
    queryKey: ["ip-mon-status", ipIds],
    // POST — a page of UUIDs makes a URL longer than proxy request-line
    // limits (gunicorn 400s at ~110 ids), which blanked the whole column.
    queryFn: () =>
      api<BulkStatusResponse>("/api/monitoring/status/", {
        method: "POST",
        body: JSON.stringify({ ips: ipIds }),
      }),
    enabled: ipIds.length > 0,
  })
  const monitoring = monQuery.data?.statuses ?? EMPTY_MON

  // Tenant custom fields for IPs → one toggleable column each (hidden by
  // default), alongside the extra built-in fields (MAC, DNS, last seen).
  const cfQuery = useCustomFieldDefs("ipaddress")
  const cfDefs = useMemo(() => cfQuery.data?.results ?? [], [cfQuery.data])

  // IP ranges carved out of this prefix → so each IP can show the range it
  // falls in (and that range's role). Containment is tested numerically.
  const rangesQuery = useQuery({
    queryKey: ["prefix-ip-ranges", prefixId],
    queryFn: () =>
      api<Paginated<IPRange>>(`/api/ip-ranges/?prefix=${prefixId}`),
  })
  const rangeSpans = useMemo(
    () =>
      (rangesQuery.data?.results ?? [])
        .map((r) => {
          const start = ipToBigInt(r.start_address)
          const end = ipToBigInt(r.end_address)
          return start != null && end != null ? { start, end, range: r } : null
        })
        .filter(
          (x): x is { start: bigint; end: bigint; range: IPRange } => !!x
        ),
    [rangesQuery.data]
  )
  const findRange = useCallback(
    (address: string): IPRange | null => {
      if (rangeSpans.length === 0) return null
      const n = ipToBigInt(address)
      if (n == null) return null
      for (const s of rangeSpans) if (n >= s.start && n <= s.end) return s.range
      return null
    },
    [rangeSpans]
  )

  const columns = useMemo<ColumnDef<IpRow>[]>(
    () =>
      buildColumns({
        hasDescendants,
        activeTagSlugs: tagFilter,
        onToggleTag,
        onEdit,
        onDelete,
        onCreateAt,
        monitoring,
        cfDefs,
        findRange,
        hasRanges: rangeSpans.length > 0,
        canEdit,
        canDelete,
        canAdd,
      }),
    [
      hasDescendants,
      tagFilter,
      onToggleTag,
      onEdit,
      onDelete,
      onCreateAt,
      monitoring,
      cfDefs,
      findRange,
      rangeSpans.length,
      canEdit,
      canDelete,
      canAdd,
    ]
  )

  const handleSelected = useCallback(
    (selected: IpRow[]) => {
      onSelectedRowsChange(
        selected
          .filter(
            (r): r is Extract<IpRow, { kind: "registered" }> =>
              r.kind === "registered"
          )
          .map((r) => r.ip)
      )
    },
    [onSelectedRowsChange]
  )

  // Extras + custom fields ship hidden so the table stays lean; users reveal
  // any of them from the Columns menu (the choice persists per-table).
  const initialVisibility = useMemo(
    () => ({
      reservation_note: false,
      mac: false,
      dns: false,
      last_seen: false,
      ...Object.fromEntries(cfDefs.map((d) => [`cf_${d.key}`, false])),
    }),
    [cfDefs]
  )

  if (query.isLoading) {
    return <p className="p-4 text-sm text-muted-foreground">Loading IPs…</p>
  }
  if (query.isError) {
    return (
      <div className="p-4">
        <QueryError error={query.error} />
      </div>
    )
  }

  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      stickyHeader
      onSelectedRowsChange={handleSelected}
      initialColumnVisibility={initialVisibility}
      tableId="prefix-ips"
    />
  )
}

// Memoised at the export — parent re-renders (dialog open toggles etc)
// won't reconcile this subtree unless props actually change identity.
export const PrefixIpsTable = memo(PrefixIpsTableImpl)

interface BuildOpts {
  hasDescendants: boolean
  activeTagSlugs: Set<string>
  onToggleTag: (slug: string) => void
  onEdit: (ip: IPAddress) => void
  onDelete: (ip: IPAddress) => void
  onCreateAt: (address: string) => void
  monitoring: Record<string, BulkStatusEntry>
  cfDefs: CustomField[]
  findRange: (address: string) => IPRange | null
  hasRanges: boolean
  canEdit: boolean
  canDelete: boolean
  canAdd: boolean
}

function buildColumns({
  hasDescendants,
  activeTagSlugs,
  onToggleTag,
  onEdit,
  onDelete,
  onCreateAt,
  monitoring,
  cfDefs,
  findRange,
  hasRanges,
  canEdit,
  canDelete,
  canAdd,
}: BuildOpts): ColumnDef<IpRow>[] {
  // Shared IP columns from the canonical factory; the page-specific columns
  // (prefix, monitoring, range, note, mac, last seen, the free-row "+ Add"
  // action) are spliced around them below.
  const cols = buildIpColumns<IpRow>({
    getIp: (r) => (r.kind === "registered" ? r.ip : null),
    selection: true,
    copyButton: true,
    freeRow: {
      address: (r) => (r.kind === "free" ? r.address : ""),
      statusLabel: "Available",
    },
    cfDefs,
    tagFilter: { activeSlugs: activeTagSlugs, onToggle: onToggleTag },
  })
  const insertAfter = (id: string, ...extra: ColumnDef<IpRow>[]) => {
    const i = cols.findIndex((c) => c.id === id)
    cols.splice(i + 1, 0, ...extra)
  }

  if (hasDescendants) {
    insertAfter("ip", {
      id: "prefix",
      header: "Prefix",
      cell: ({ row }) => {
        if (row.original.kind !== "registered") return null
        const ip = row.original.ip
        if (!ip.prefix) {
          return <span className="text-[11px] text-muted-foreground/60">—</span>
        }
        return (
          <Link
            to="/prefixes/$id"
            params={{ id: ip.prefix.id }}
            className="font-mono text-[12px] text-muted-foreground hover:underline"
          >
            {ip.prefix.cidr}
          </Link>
        )
      },
    })
  }

  insertAfter("status", {
    id: "monitoring",
    header: "Monitoring",
    enableSorting: false,
    cell: ({ row }) => {
      if (row.original.kind !== "registered") return null
      const e = monitoring[row.original.ip.id]
      if (!e || !e.status) return dash
      return <MixedStatusBadge counts={e.counts} status={e.status} />
    },
  })

  if (hasRanges) {
    // The Range column only earns its keep when this prefix has ranges.
    insertAfter("role", {
      id: "range",
      accessorFn: (r) => {
        const addr = r.kind === "registered" ? r.ip.ip_address : r.address
        const rng = findRange(addr)
        return rng
          ? (rng.role?.name ?? `${rng.start_address}–${rng.end_address}`)
          : ""
      },
      header: "Range",
      cell: ({ row }) => {
        const addr =
          row.original.kind === "registered"
            ? row.original.ip.ip_address
            : row.original.address
        const rng = findRange(addr)
        if (!rng) return <span className="text-muted-foreground/60">—</span>
        return (
          <Link
            to="/ip-ranges/$id"
            params={{ id: rng.id }}
            className="inline-flex items-center gap-1.5 hover:opacity-90"
            title={`${rng.start_address}–${rng.end_address}`}
          >
            {rng.role ? (
              <RoleChip role={rng.role} />
            ) : (
              <span className="font-mono text-[11px] text-muted-foreground">
                {rng.start_address}–{rng.end_address}
              </span>
            )}
          </Link>
        )
      },
    })
  }

  insertAfter(
    "description",
    {
      id: "reservation_note",
      accessorFn: (r) => (r.kind === "registered" ? r.ip.reservation_note : ""),
      header: "Note",
      cell: ({ row }) => {
        if (row.original.kind !== "registered") return null
        const note = row.original.ip.reservation_note
        if (!note) return dash
        return (
          <span className="text-xs text-muted-foreground italic">{note}</span>
        )
      },
    },
    {
      id: "mac",
      accessorFn: (r) => (r.kind === "registered" ? r.ip.mac_address : ""),
      header: "MAC",
      cell: ({ row }) => {
        if (row.original.kind !== "registered") return null
        const v = row.original.ip.mac_address
        return v ? <span className="font-mono text-[12px]">{v}</span> : dash
      },
    },
    timeAgoColumn<IpRow>({
      id: "last_seen",
      header: "Last seen",
      get: (r) =>
        r.kind === "registered" ? (r.ip.last_seen ?? undefined) : undefined,
      align: "right",
    })
  )

  cols.push({
    id: "actions",
    enableHiding: false,
    cell: ({ row }) => {
      if (row.original.kind === "free") {
        if (!canAdd) return null
        const addr = row.original.address
        return (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-[11px]"
            onClick={() => onCreateAt(addr)}
          >
            + Add
          </Button>
        )
      }
      const ip = row.original.ip
      return (
        <RowActions
          onEdit={objCan(ip, "change", canEdit) ? () => onEdit(ip) : undefined}
          onDelete={
            objCan(ip, "delete", canDelete) ? () => onDelete(ip) : undefined
          }
        />
      )
    },
  })

  return cols
}
