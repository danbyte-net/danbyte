import { type ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { Info } from "lucide-react"

import type { CustomField, IPAddress } from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import { RoleChip } from "@/components/role-chip"
import { CopyButton } from "@/components/kv-card"
import { dash } from "@/components/cells/dash"
import { DeviceCell } from "@/components/cells/device-cell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { formatCustomValue } from "@/components/custom-field-display"
import {
  actionsColumn,
  type ActionsColumnOpts,
} from "@/components/columns/actions-column"

// The one source of truth for "a table of IP addresses". Every surface that
// lists IPs — the prefix IPs pane, the device IPs pane, embedded IP tables —
// builds its shared columns here so an IP row reads identically everywhere.
// Page-specific columns (designation, monitoring, range, …) are spliced
// around this factory's output.
//
// Rows don't have to *be* IPAddress objects: pass `getIp` to project the IP
// out of a wrapper row (e.g. the prefix pane's registered/free union). Rows
// where `getIp` returns null render the `freeRow` fallbacks.

export type IpColumnId =
  | "ip"
  | "status"
  | "role"
  | "dns"
  | "assigned"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: IpColumnId[] = [
  "ip",
  "status",
  "role",
  "dns",
  "assigned",
  "description",
  "tags",
  "updated",
]

export interface IpColumnOpts<T> {
  /** Project the IPAddress out of a wrapper row. Defaults to identity. */
  getIp?: (row: T) => IPAddress | null | undefined
  /** Drop columns. */
  omit?: IpColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: IpColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Copy-to-clipboard button next to the address (device pane). */
  copyButton?: boolean
  /** Rendering for rows where getIp() returns null (free addresses). */
  freeRow?: { address: (row: T) => string; statusLabel?: string }
  /** One column per tenant custom field. */
  cfDefs?: CustomField[]
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** Stable facet bucket for a custom-field value (null = not counted). */
function cfFacetKey(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null
  if (typeof v === "boolean") return v ? "Yes" : "No"
  if (Array.isArray(v)) return v.map(String).join(", ")
  return String(v)
}

export function buildIpColumns<T = IPAddress>(
  opts: IpColumnOpts<T> = {}
): ColumnDef<T, unknown>[] {
  const getIp =
    opts.getIp ?? ((r: T) => r as unknown as IPAddress | null | undefined)
  const omit = new Set(opts.omit ?? [])
  const keep = (id: IpColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<IpColumnId, () => ColumnDef<T, unknown>> = {
    ip: () => ({
      id: "ip",
      accessorFn: (r) => getIp(r)?.ip_address ?? opts.freeRow?.address(r) ?? "",
      header: ({ column }) => <SortHeader column={column} label="Address" />,
      cell: ({ row }) => {
        const ip = getIp(row.original)
        if (!ip) {
          return opts.freeRow ? (
            <span className="font-mono text-xs text-muted-foreground italic">
              {opts.freeRow.address(row.original)}
            </span>
          ) : (
            dash
          )
        }
        const link = (
          <Link
            to="/ips/$id"
            params={{ id: ip.id }}
            className="font-mono font-medium hover:underline"
          >
            {ip.ip_address}
          </Link>
        )
        if (!opts.copyButton) return link
        return (
          <div className="flex items-center gap-1">
            {link}
            <CopyButton value={ip.ip_address} />
          </div>
        )
      },
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) =>
        getIp(r)?.status?.name ?? opts.freeRow?.statusLabel ?? "",
      header: ({ column }) => <SortHeader column={column} label="Status" />,
      cell: ({ row }) => {
        const ip = getIp(row.original)
        if (!ip) {
          return opts.freeRow?.statusLabel ? (
            <span className="text-muted-foreground">
              {opts.freeRow.statusLabel}
            </span>
          ) : (
            dash
          )
        }
        return (
          <span
            className="inline-flex items-center gap-1.5"
            title={ip.reservation_note || undefined}
          >
            <StatusBadge status={ip.status} />
            {ip.reservation_note && (
              <Info
                className="h-3 w-3 text-amber-500"
                aria-label="Has reservation note"
              />
            )}
          </span>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: T) => getIp(r)?.status?.id ?? "__none__",
          formatValue: (_v, sample) => {
            const s = getIp(sample)?.status
            return {
              label: s?.name ?? "No status",
              color: s?.color,
              textColor: s?.text_color,
            }
          },
        },
      },
    }),
    role: () => ({
      id: "role",
      accessorFn: (r) => getIp(r)?.role?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Role" />,
      cell: ({ row }) => {
        const ip = getIp(row.original)
        return ip ? <RoleChip role={ip.role} /> : null
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Role",
          get: (r: T) => getIp(r)?.role?.id ?? "__none__",
          formatValue: (_v, sample) => {
            const role = getIp(sample)?.role
            return {
              label: role?.name ?? "No role",
              color: role?.color ?? undefined,
              textColor: role?.text_color ?? undefined,
            }
          },
        },
      },
    }),
    dns: () => ({
      id: "dns",
      accessorFn: (r) => getIp(r)?.dns_name ?? "",
      header: "DNS name",
      cell: ({ row }) => {
        const v = getIp(row.original)?.dns_name
        return v ? <span className="font-mono text-xs">{v}</span> : dash
      },
    }),
    assigned: () => ({
      id: "assigned",
      accessorFn: (r) => {
        const ip = getIp(r)
        return ip?.assigned_device?.name ?? ip?.assigned_vm?.name ?? ""
      },
      header: "Assigned to",
      cell: ({ row }) => {
        const ip = getIp(row.original)
        if (ip?.assigned_device)
          return (
            <DeviceCell
              device={ip.assigned_device}
              primary={ip.is_primary_for_device}
              className="text-xs"
            />
          )
        if (ip?.assigned_vm)
          return <span className="text-xs">{ip.assigned_vm.name}</span>
        return dash
      },
    }),
    description: () => ({
      id: "description",
      accessorFn: (r) => getIp(r)?.description ?? "",
      header: "Description",
      cell: ({ row }) => {
        const ip = getIp(row.original)
        if (!ip) return null
        return (
          <span
            className="block whitespace-nowrap text-muted-foreground"
            title={ip.description}
          >
            {ip.description || "—"}
          </span>
        )
      },
    }),
    tags: () =>
      tagsColumn<T>({
        getTags: (r) => getIp(r)?.tags ?? [],
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
    updated: () =>
      timeAgoColumn<T>({
        id: "updated",
        header: "Updated",
        get: (r) => getIp(r)?.updated_at ?? undefined,
        align: "right",
      }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())

  // One column per tenant IP custom field — hidden by default, toggleable.
  // Each carries an enum facet over its observed values so any facet rail
  // built from these columns adapts to the tenant's custom fields.
  for (const d of opts.cfDefs ?? []) {
    cols.push({
      id: `cf_${d.key}`,
      header: d.label,
      enableSorting: false,
      accessorFn: (r) => getIp(r)?.custom_fields?.[d.key],
      cell: ({ row }) => {
        const ip = getIp(row.original)
        return ip ? formatCustomValue(d, ip.custom_fields?.[d.key]) : null
      },
      meta: {
        facet: {
          kind: "enum",
          label: d.label,
          get: (r: T) => cfFacetKey(getIp(r)?.custom_fields?.[d.key]),
        },
      },
    })
  }

  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
