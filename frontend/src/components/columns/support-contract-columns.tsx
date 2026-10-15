import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { SupportContract } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { SortHeader, selectionColumn } from "@/components/data-table"
import {
  CONTRACT_STATE_LABELS,
  ContractStateBadge,
} from "@/components/cells/coverage-cell"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of support contracts" (#421).

export type SupportContractColumnId =
  | "numid"
  | "contract_number"
  | "manufacturer"
  | "service_level"
  | "start_date"
  | "end_date"
  | "state"
  | "devices"
  | "reseller"
  | "cost"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: SupportContractColumnId[] = [
  "numid",
  "contract_number",
  "manufacturer",
  "service_level",
  "state",
  "start_date",
  "end_date",
  "devices",
  "reseller",
  "cost",
  "description",
  "tags",
  "updated",
]

export interface SupportContractColumnOpts<
  T extends SupportContract = SupportContract,
> {
  omit?: SupportContractColumnId[]
  include?: SupportContractColumnId[]
  selection?: boolean
  humanIds?: boolean
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  actions?: ActionsColumnOpts<T>
}

/** A date-only value (`YYYY-MM-DD`) in the user's date format. */
export function DateText({ value }: { value: string | null | undefined }) {
  const { formatDate } = useDateFormat()
  if (!value) return dash
  return <span className="num text-xs">{formatDate(value)}</span>
}

/** "1,200.00 EUR" - the cost with its currency. */
export function formatCost(
  cost: number | null | undefined,
  currency: string
): string {
  if (cost == null) return ""
  const n = Number(cost).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
  return currency ? `${n} ${currency}` : n
}

export function buildSupportContractColumns<
  T extends SupportContract = SupportContract,
>(opts: SupportContractColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: SupportContractColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<SupportContractColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    contract_number: () => ({
      id: "contract_number",
      accessorKey: "contract_number",
      header: ({ column }) => <SortHeader column={column} label="Contract" />,
      cell: ({ row }) => (
        <Link
          to="/support-contracts/$id"
          params={{ id: row.original.id }}
          className="link font-mono text-xs font-medium"
        >
          {row.original.contract_number}
        </Link>
      ),
      meta: { export: { value: (r: T) => r.contract_number } },
    }),
    manufacturer: () => ({
      id: "manufacturer",
      accessorFn: (c) => c.manufacturer.name,
      header: ({ column }) => (
        <SortHeader column={column} label="Manufacturer" />
      ),
      cell: ({ row }) => (
        <Link
          to="/manufacturers/$id"
          params={{ id: row.original.manufacturer.id }}
          className="link text-xs"
        >
          {row.original.manufacturer.name}
        </Link>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Manufacturer",
          get: (r: T) => r.manufacturer.id,
          formatValue: (_v, s) => ({ label: s.manufacturer.name }),
        },
      },
    }),
    service_level: () => ({
      id: "service_level",
      accessorKey: "service_level",
      header: ({ column }) => (
        <SortHeader column={column} label="Service level" />
      ),
      cell: ({ row }) =>
        row.original.service_level ? (
          <span className="text-xs">{row.original.service_level}</span>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Service level",
          get: (r: T) => r.service_level || "__none__",
          formatValue: (v) => ({ label: v === "__none__" ? "None" : v }),
        },
      },
    }),
    state: () => ({
      id: "state",
      accessorFn: (r) => r.state,
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) => <ContractStateBadge state={row.original.state} />,
      meta: {
        facet: {
          kind: "enum",
          label: "State",
          get: (r: T) => r.state,
          formatValue: (v) => ({
            label:
              (CONTRACT_STATE_LABELS as Record<string, string | undefined>)[
                v
              ] ?? v,
          }),
        },
        export: { value: (r: T) => CONTRACT_STATE_LABELS[r.state] },
      },
    }),
    start_date: () => ({
      id: "start_date",
      accessorFn: (r) => r.start_date ?? "",
      header: ({ column }) => <SortHeader column={column} label="Start" />,
      cell: ({ row }) => <DateText value={row.original.start_date} />,
    }),
    end_date: () => ({
      id: "end_date",
      // Open-ended sorts last.
      accessorFn: (r) => r.end_date ?? "9999-12-31",
      header: ({ column }) => <SortHeader column={column} label="End" />,
      cell: ({ row }) =>
        row.original.end_date ? (
          <DateText value={row.original.end_date} />
        ) : (
          <span className="text-xs text-muted-foreground">Open-ended</span>
        ),
      meta: { export: { value: (r: T) => r.end_date ?? "" } },
    }),
    devices: () => ({
      id: "devices",
      accessorKey: "device_count",
      header: ({ column }) => <SortHeader column={column} label="Devices" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.device_count}</span>
      ),
    }),
    reseller: () => ({
      id: "reseller",
      accessorKey: "reseller",
      header: ({ column }) => <SortHeader column={column} label="Reseller" />,
      cell: ({ row }) =>
        row.original.reseller ? (
          <span className="text-xs">{row.original.reseller}</span>
        ) : (
          dash
        ),
    }),
    cost: () => ({
      id: "cost",
      accessorFn: (r) => r.cost ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Cost" />,
      cell: ({ row }) => {
        const text = formatCost(row.original.cost, row.original.currency)
        return text ? <span className="num text-xs">{text}</span> : dash
      },
      meta: {
        export: { value: (r: T) => formatCost(r.cost, r.currency) },
      },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
