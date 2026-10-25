import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  ApplicationGroup,
  ApplicationGroupAssignment,
  ApplicationGroupMember,
} from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"
import { applicationAncestors } from "@/components/columns/application-columns"

// The one source of truth for "a table of application groups" (#436).

export type ApplicationGroupColumnId =
  | "numid"
  | "name"
  | "slug"
  | "members"
  | "hosts"
  | "installs"
  | "description"
  | "updated"

const CANONICAL_ORDER: ApplicationGroupColumnId[] = [
  "numid",
  "name",
  "slug",
  "members",
  "hosts",
  "installs",
  "description",
  "updated",
]

export interface ApplicationGroupColumnOpts<
  T extends ApplicationGroup = ApplicationGroup,
> {
  omit?: ApplicationGroupColumnId[]
  include?: ApplicationGroupColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

export function buildApplicationGroupColumns<
  T extends ApplicationGroup = ApplicationGroup,
>(opts: ApplicationGroupColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: ApplicationGroupColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<ApplicationGroupColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid ?? null }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/application-groups/$id"
          params={{ id: row.original.id }}
          className="link font-medium whitespace-nowrap"
        >
          {row.original.name}
        </Link>
      ),
    }),
    slug: () => ({
      id: "slug",
      accessorKey: "slug",
      header: ({ column }) => <SortHeader column={column} label="Slug" />,
      cell: ({ row }) => (
        <span className="font-mono text-xs">{row.original.slug}</span>
      ),
      meta: { label: "Slug", defaultHidden: true },
    }),
    members: () => ({
      id: "members",
      accessorKey: "member_count",
      header: ({ column }) => (
        <SortHeader column={column} label="Applications" />
      ),
      cell: ({ row }) => (
        <span className="num">{row.original.member_count}</span>
      ),
    }),
    hosts: () => ({
      id: "hosts",
      accessorKey: "host_count",
      header: ({ column }) => <SortHeader column={column} label="Hosts" />,
      cell: ({ row }) => <span className="num">{row.original.host_count}</span>,
    }),
    installs: () => ({
      id: "installs",
      accessorKey: "install_count",
      header: ({ column }) => <SortHeader column={column} label="Installs" />,
      cell: ({ row }) => (
        <span className="num">{row.original.install_count}</span>
      ),
      meta: { label: "Installs", defaultHidden: true },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "-"}
        </span>
      ),
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

// ─── members ─────────────────────────────────────────────────────────────

/** A group's applications in their order: position, application (its tree
 * path muted before the name) and the version its installs start at. Not
 * sortable - the order is the group's. */
export function buildApplicationGroupMemberColumns(
  opts: { actions?: ActionsColumnOpts<ApplicationGroupMember> } = {}
): ColumnDef<ApplicationGroupMember, unknown>[] {
  const cols: ColumnDef<ApplicationGroupMember, unknown>[] = [
    {
      id: "position",
      header: "#",
      enableSorting: false,
      cell: ({ row }) => (
        <span className="num text-muted-foreground">{row.index + 1}</span>
      ),
    },
    {
      id: "application",
      accessorFn: (m) => m.application.path || m.application.name,
      header: "Application",
      enableSorting: false,
      cell: ({ row }) => {
        const a = row.original.application
        const above = applicationAncestors(a.path, a.name)
        return (
          <span className="whitespace-nowrap">
            {above && <span className="text-muted-foreground">{above} › </span>}
            <Link
              to="/applications/$id"
              params={{ id: a.id }}
              className="link font-medium"
            >
              {a.name}
            </Link>
          </span>
        )
      },
    },
    {
      id: "version",
      accessorKey: "version",
      header: "Version",
      enableSorting: false,
      cell: ({ row }) =>
        row.original.version ? (
          <span className="font-mono text-xs">{row.original.version}</span>
        ) : (
          dash
        ),
    },
  ]
  if (opts.actions) cols.push(actionsColumn(opts.actions))
  return cols
}

// ─── assignments ─────────────────────────────────────────────────────────

/** The devices and VMs a group is assigned to. */
export function buildApplicationGroupAssignmentColumns(
  opts: { actions?: ActionsColumnOpts<ApplicationGroupAssignment> } = {}
): ColumnDef<ApplicationGroupAssignment, unknown>[] {
  const cols: ColumnDef<ApplicationGroupAssignment, unknown>[] = [
    {
      id: "host",
      accessorFn: (a) => a.device?.name ?? a.virtual_machine?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Host" />,
      cell: ({ row }) => {
        const { device, virtual_machine: vm } = row.original
        if (device)
          return (
            <Link
              to="/devices/$id"
              params={{ id: device.id }}
              className="link font-medium"
            >
              {device.name}
            </Link>
          )
        if (vm)
          return (
            <Link
              to="/virtual-machines/$id"
              params={{ id: vm.id }}
              className="link font-medium"
            >
              {vm.name}
            </Link>
          )
        return dash
      },
    },
    {
      id: "kind",
      accessorFn: (a) => (a.device ? "Device" : "Virtual machine"),
      header: ({ column }) => <SortHeader column={column} label="Kind" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground">
          {row.original.device ? "Device" : "Virtual machine"}
        </span>
      ),
    },
    {
      id: "installs",
      accessorKey: "install_count",
      header: ({ column }) => <SortHeader column={column} label="Installs" />,
      cell: ({ row }) => (
        <span className="num">{row.original.install_count}</span>
      ),
    },
    timeAgoColumn<ApplicationGroupAssignment>({
      id: "assigned",
      header: "Assigned",
      get: (a) => a.created_at,
      align: "right",
    }),
  ]
  if (opts.actions) cols.push(actionsColumn(opts.actions))
  return cols
}
