import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type { ConfigContext } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { numidColumn } from "@/components/cells/numid"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"

// The one source of truth for "a table of config contexts" - /config-contexts
// builds here.

export type ConfigContextColumnId =
  "numid" | "name" | "weight" | "criteria" | "keys"

const CANONICAL_ORDER: ConfigContextColumnId[] = [
  "numid",
  "name",
  "weight",
  "criteria",
  "keys",
]

export interface ConfigContextColumnOpts<
  T extends ConfigContext = ConfigContext,
> {
  omit?: ConfigContextColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** What a context applies to, in a few words. */
export function contextCriteria(c: ConfigContext): string {
  const parts: string[] = []
  if (c.regions.length) parts.push(`${c.regions.length} region(s)`)
  if (c.sites.length) parts.push(`${c.sites.length} site(s)`)
  if (c.device_roles.length) parts.push(`${c.device_roles.length} role(s)`)
  if (c.platforms.length) parts.push(`${c.platforms.length} platform(s)`)
  return parts.join(" · ") || "All devices/VMs"
}

export function buildConfigContextColumns<
  T extends ConfigContext = ConfigContext,
>(opts: ConfigContextColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")

  const byId: Record<ConfigContextColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/config-contexts/$id"
          params={{ id: row.original.id }}
          className="link flex items-center gap-2 font-medium"
        >
          {row.original.name}
          {!row.original.is_active && (
            <Badge variant="secondary" className="text-[10px]">
              inactive
            </Badge>
          )}
        </Link>
      ),
    }),
    weight: () => ({
      id: "weight",
      accessorKey: "weight",
      header: ({ column }) => <SortHeader column={column} label="Weight" />,
      cell: ({ row }) => (
        <span className="num text-xs">{row.original.weight}</span>
      ),
    }),
    criteria: () => ({
      id: "criteria",
      header: "Applies to",
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {contextCriteria(row.original)}
        </span>
      ),
    }),
    keys: () => ({
      id: "keys",
      header: "Data keys",
      cell: ({ row }) => {
        const keys = Object.keys(row.original.data)
        return (
          <span className="font-mono text-[11px] text-muted-foreground">
            {keys.length ? keys.join(", ") : "-"}
          </span>
        )
      },
    }),
  }

  const cols: ColumnDef<T, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<T>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  if (opts.actions) cols.push(actionsColumn<T>(opts.actions))
  return cols
}
