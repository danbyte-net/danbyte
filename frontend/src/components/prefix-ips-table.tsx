import { memo, useCallback, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Search } from "lucide-react"
import { useTableFilters } from "@/components/table-filters"
import { Input } from "@/components/ui/input"
import {
  monitoringBucket,
  monitoringFacet,
} from "@/components/columns/monitoring-facet"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { type ColumnDef } from "@tanstack/react-table"

import {
  api,
  type BulkStatusEntry,
  type BulkStatusResponse,
  type CustomField,
  type DhcpScopeRange,
  type IPAddress,
  type IPListResponse,
  type IPRange,
  type Paginated,
} from "@/lib/api"
import type { DhcpState } from "@/components/dhcp-badge"
import { objCan } from "@/lib/use-me"
import { ipToBigInt, bigIntToIp, enumerableHostInts } from "@/lib/prefix-tree"
import { MixedStatusBadge } from "@/components/monitoring/mixed-status-badge"
import { DataTable, SortHeader } from "@/components/data-table"
import { buildIpColumns } from "@/components/columns/ip-columns"
import { dash } from "@/components/cells/dash"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { useCustomFieldDefs } from "@/components/custom-field-display"
import { QueryError } from "@/components/query-error"
import { RoleChip } from "@/components/role-chip"
import { Button } from "@/components/ui/button"
import { RowActions } from "@/components/row-actions"

// Synthetic row union - real registered IPs interleaved with placeholders
// for free addresses when "Show available" is on.
export type IpRow =
  | { kind: "registered"; ip: IPAddress }
  | { kind: "free"; address: string; more?: number }

// Stable empty fallback so `columns` (which depends on `monitoring`) keeps a
// constant identity while the bulk status query loads.
const EMPTY_MON: Record<string, BulkStatusEntry> = {}

interface PrefixIpsTableProps {
  prefixId: string
  /** Non-facet controls for the rail (Show available, Compact, DHCP pool);
   * the facets themselves derive from the columns. */
  railExtras?: ReactNode
  showAvailable: boolean
  /** Show the DHCP scope pool's addresses as ghost rows even when they have no
   * IP row yet - the pool laid out without creating anything. */
  showDhcpPool: boolean
  /** The prefix CIDR - needed to enumerate free host addresses. */
  cidr: string
  /** Limit the table to one span inside the prefix (an IP range): only the
   * registered IPs inside it, and free addresses enumerated from it. */
  span?: { start: string; end: string }
  /** The prefix allocates only from these ranges: free addresses are
   * enumerated from them instead of the whole prefix. */
  spans?: { start: string; end: string }[]
  /** One free row standing for all of them ("first free · N more"), instead
   * of a row per free address. */
  compact?: boolean
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
  railExtras,
  showAvailable,
  showDhcpPool,
  cidr,
  span,
  spans,
  compact = false,
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

  // DHCP scope pool ranges (from the ips endpoint) → shade free addresses that
  // fall inside a pool, and back the "Show DHCP pool" ghost rows. Exclusion
  // ranges carve holes in the pool - those addresses are static space, not
  // pool space. Registered rows carry their own `dhcp` state already.
  const dhcpSpans = useMemo(
    () =>
      (query.data?.dhcp_ranges ?? [])
        .map((r: DhcpScopeRange) => {
          const start = ipToBigInt(r.start)
          const end = ipToBigInt(r.end)
          if (start == null || end == null) return null
          const exclusions = (r.exclusions ?? [])
            .map((e) => {
              const s = ipToBigInt(e.start)
              const x = ipToBigInt(e.end)
              return s != null && x != null ? { start: s, end: x } : null
            })
            .filter((x): x is { start: bigint; end: bigint } => !!x)
          return { start, end, exclusions }
        })
        .filter((x): x is NonNullable<typeof x> => !!x),
    [query.data]
  )
  const inExclusion = useCallback(
    (n: bigint) =>
      dhcpSpans.some((s) =>
        s.exclusions.some((e) => n >= e.start && n <= e.end)
      ),
    [dhcpSpans]
  )
  const inPool = useCallback(
    (n: bigint) =>
      !inExclusion(n) && dhcpSpans.some((s) => n >= s.start && n <= s.end),
    [dhcpSpans, inExclusion]
  )

  // Registered addresses inside the span, as table rows - the set the filter
  // rail derives its facets from. Free rows never carry a facet value.
  const spanInts = useMemo(
    () =>
      span && ipToBigInt(span.start) !== null && ipToBigInt(span.end) !== null
        ? { start: ipToBigInt(span.start)!, end: ipToBigInt(span.end)! }
        : null,
    [span]
  )
  const registered = useMemo<IpRow[]>(
    () =>
      (query.data?.results ?? [])
        .filter((ip) => {
          if (!spanInts) return true
          const n = ipToBigInt(ip.ip_address)
          return n !== null && n >= spanInts.start && n <= spanInts.end
        })
        .map((ip) => ({ kind: "registered" as const, ip })),
    [query.data, spanInts]
  )

  // Monitoring status for the registered IPs (bulk, decoupled query) - for
  // every row in the span, so the rail can facet on it before filtering.
  const ipIds = useMemo(
    () =>
      registered
        .filter(
          (r): r is Extract<IpRow, { kind: "registered" }> =>
            r.kind === "registered"
        )
        .map((r) => r.ip.id),
    [registered]
  )
  const monQuery = useQuery({
    queryKey: ["ip-mon-status", ipIds],
    // POST - a page of UUIDs makes a URL longer than proxy request-line
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

  const dhcpStateForRow = useCallback(
    (r: IpRow): DhcpState | null => {
      if (r.kind === "registered") return r.ip.dhcp ?? null
      const n = ipToBigInt(r.address)
      if (n == null) return null
      if (inExclusion(n)) return "exclusion"
      return inPool(n) ? "scope" : null
    },
    [inExclusion, inPool]
  )

  const columns = useMemo<ColumnDef<IpRow>[]>(
    () =>
      buildColumns({
        hasDescendants,
        onEdit,
        onDelete,
        onCreateAt,
        monitoring,
        cfDefs,
        findRange,
        hasRanges: rangeSpans.length > 0,
        dhcpStateForRow,
        canEdit,
        canDelete,
        canAdd,
      }),
    [
      hasDescendants,
      onEdit,
      onDelete,
      onCreateAt,
      monitoring,
      cfDefs,
      findRange,
      rangeSpans.length,
      dhcpStateForRow,
      canEdit,
      canDelete,
      canAdd,
    ]
  )

  // The shared rail + click-to-filter wiring, over the registered rows.
  const {
    rail,
    columns: wiredColumns,
    filteredRows,
    activeCount,
  } = useTableFilters(columns, registered, undefined, { railExtras })
  const [search, setSearch] = useState("")

  const rows = useMemo<IpRow[]>(() => {
    const q = search.trim().toLowerCase()
    const registeredRows = filteredRows.filter((r) => {
      if (r.kind !== "registered" || !q) return true
      const ip = r.ip
      const haystack =
        ip.ip_address +
        " " +
        (ip.description || "") +
        " " +
        (ip.assigned_device?.name || "") +
        " " +
        (ip.reservation_note || "")
      return haystack.toLowerCase().includes(q)
    })

    // Ghost rows for unregistered addresses. Only when no facet is active
    // (free addresses have none).
    //   "Show available" - every free host in the prefix (≤ enumeration cap;
    //     null = too big, e.g. a /64).
    //   "Show DHCP pool" - just the scope pool's free addresses, laid out
    //     without creating anything. Pools are bounded ranges, so this works
    //     even in prefixes too large to enumerate fully.
    const freeRows: IpRow[] = []
    if ((showAvailable || showDhcpPool) && activeCount === 0) {
      const taken = new Set<bigint>()
      for (const r of registered) {
        if (r.kind !== "registered") continue
        const b = ipToBigInt(r.ip.ip_address)
        if (b !== null) taken.add(b)
      }
      const family: 4 | 6 = cidr.includes(":") ? 6 : 4
      const pushFree = (n: bigint) => {
        if (taken.has(n)) return
        taken.add(n) // dedupe across sources (prefix hosts vs pool spans)
        const address = bigIntToIp(n, family)
        if (q && !address.toLowerCase().includes(q)) return
        freeRows.push({ kind: "free", address })
      }
      if (showAvailable && spanInts) {
        let budget = 4096
        for (let n = spanInts.start; n <= spanInts.end && budget > 0; n++) {
          pushFree(n)
          budget--
        }
      } else if (showAvailable && spans) {
        let budget = 4096
        for (const sp of spans) {
          const a = ipToBigInt(sp.start)
          const b = ipToBigInt(sp.end)
          if (a === null || b === null) continue
          for (let n = a; n <= b && budget > 0; n++) {
            pushFree(n)
            budget--
          }
        }
      } else if (showAvailable) {
        const hosts = enumerableHostInts(cidr)
        if (hosts) for (const n of hosts.ints) pushFree(n)
      } else {
        // Pool-only view: enumerate each scope span directly (skipping the
        // exclusion holes), capped so a misconfigured giant range can't flood
        // the table.
        let budget = 4096
        for (const s of dhcpSpans) {
          for (let n = s.start; n <= s.end && budget > 0; n++) {
            if (s.exclusions.some((e) => n >= e.start && n <= e.end)) continue
            pushFree(n)
            budget--
          }
        }
      }
    }

    // Compact: the first free address stands for the rest.
    const first = freeRows[0]
    const shownFree: IpRow[] =
      compact && freeRows.length > 1 && first.kind === "free"
        ? [{ kind: "free", address: first.address, more: freeRows.length - 1 }]
        : freeRows
    const merged = [...registeredRows, ...shownFree]
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
    filteredRows,
    registered,
    activeCount,
    search,
    spanInts,
    spans,
    compact,
    showAvailable,
    showDhcpPool,
    dhcpSpans,
    cidr,
  ])

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
    <div className="flex min-h-0 flex-1">
      {rail}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="num text-[11px] text-muted-foreground">
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </span>
          <div className="relative ml-auto">
            <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Filter IPs…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="h-8 w-64 pl-8 text-xs"
            />
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <DataTable
            data={rows}
            columns={wiredColumns}
            flexColumn="description"
            stickyHeader
            onSelectedRowsChange={handleSelected}
            initialColumnVisibility={initialVisibility}
            tableId="prefix-ips"
          />
        </div>
      </div>
    </div>
  )
}

// Memoised at the export - parent re-renders (dialog open toggles etc)
// won't reconcile this subtree unless props actually change identity.
export const PrefixIpsTable = memo(PrefixIpsTableImpl)

interface BuildOpts {
  hasDescendants: boolean
  onEdit: (ip: IPAddress) => void
  onDelete: (ip: IPAddress) => void
  onCreateAt: (address: string) => void
  monitoring: Record<string, BulkStatusEntry>
  cfDefs: CustomField[]
  findRange: (address: string) => IPRange | null
  hasRanges: boolean
  dhcpStateForRow: (row: IpRow) => DhcpState | null
  canEdit: boolean
  canDelete: boolean
  canAdd: boolean
}

function buildColumns({
  hasDescendants,
  onEdit,
  onDelete,
  onCreateAt,
  monitoring,
  cfDefs,
  findRange,
  hasRanges,
  dhcpStateForRow,
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
      onPick: canAdd
        ? (r) => {
            if (r.kind === "free") onCreateAt(r.address)
          }
        : undefined,
      more: (r) => (r.kind === "free" ? (r.more ?? 0) : 0),
      statusLabel: "Available",
    },
    dhcpState: dhcpStateForRow,
    cfDefs,
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
          return <span className="text-[11px] text-muted-foreground/60">-</span>
        }
        return (
          <Link
            to="/prefixes/$id"
            params={{ id: ip.prefix.id }}
            className="link font-mono text-[12px] text-muted-foreground"
          >
            {ip.prefix.cidr}
          </Link>
        )
      },
    })
  }

  const rollup = (r: IpRow) =>
    r.kind === "registered" ? monitoring[r.ip.id] : null
  insertAfter("status", {
    id: "monitoring",
    accessorFn: (r) => monitoringBucket(rollup(r) ?? undefined),
    header: ({ column }) => <SortHeader column={column} label="Monitoring" />,
    cell: ({ row }) => {
      if (row.original.kind !== "registered") return null
      const e = monitoring[row.original.ip.id]
      if (!e || !e.status) return dash
      return <MixedStatusBadge counts={e.counts} status={e.status} />
    },
    meta: { facet: monitoringFacet<IpRow>(rollup) },
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
        if (!rng) return <span className="text-muted-foreground/60">-</span>
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
