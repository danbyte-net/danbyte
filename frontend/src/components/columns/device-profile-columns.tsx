import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"

import type {
  DeviceProfile,
  DeviceProfileAssignment,
  HostDeviceProfile,
} from "@/lib/api"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { ColorBadge } from "@/components/cells/color-badge"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { Badge } from "@/components/ui/badge"
import { actionsColumn } from "@/components/columns/actions-column"
import type { ActionsColumnOpts } from "@/components/columns/actions-column"
import {
  ProfileStateBadge,
  profileStateLabel,
} from "@/components/device-profile-assign"

// The one source of truth for "a table of device profiles", of a profile's
// assigned objects, and the Profiles column on the device and VM lists.

export type DeviceProfileColumnId =
  | "numid"
  | "name"
  | "parent"
  | "applies_to"
  | "groups"
  | "assigned"
  | "children"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: DeviceProfileColumnId[] = [
  "numid",
  "name",
  "parent",
  "applies_to",
  "groups",
  "assigned",
  "children",
  "description",
  "tags",
  "updated",
]

export interface DeviceProfileColumnOpts<
  T extends DeviceProfile = DeviceProfile,
> {
  omit?: DeviceProfileColumnId[]
  include?: DeviceProfileColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column - gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Trailing RowActions column. */
  actions?: ActionsColumnOpts<T>
}

/** The names above a profile in its chain: "Base › RDS" for "RDS HR". */
export function profileAncestors(path: string, name: string): string {
  const parts = path.split(" / ")
  if (parts.length < 2 || parts[parts.length - 1] !== name) return ""
  return parts.slice(0, -1).join(" › ")
}

export function appliesToLabel(p: {
  applies_to_devices: boolean
  applies_to_vms: boolean
}): string {
  if (p.applies_to_devices && p.applies_to_vms) return "Devices, VMs"
  return p.applies_to_devices ? "Devices" : "VMs"
}

export function buildDeviceProfileColumns<
  T extends DeviceProfile = DeviceProfile,
>(opts: DeviceProfileColumnOpts<T> = {}): ColumnDef<T, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: DeviceProfileColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const byId: Record<DeviceProfileColumnId, () => ColumnDef<T, unknown>> = {
    numid: () => numidColumn<T>({ get: (r) => r.numid ?? null }),
    name: () => ({
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Name" />,
      cell: ({ row }) => (
        <Link
          to="/device-profiles/$id"
          params={{ id: row.original.id }}
          className="inline-flex"
        >
          <ColorBadge
            name={row.original.name}
            color={row.original.color || undefined}
          />
        </Link>
      ),
    }),
    parent: () => ({
      id: "parent",
      accessorFn: (r) => profileAncestors(r.path, r.name),
      header: ({ column }) => <SortHeader column={column} label="Parent" />,
      cell: ({ row }) => {
        const above = profileAncestors(row.original.path, row.original.name)
        const parent = row.original.parent
        if (!parent) return dash
        return (
          <span className="whitespace-nowrap text-muted-foreground">
            {above.includes(" › ") &&
              `${above.slice(0, above.lastIndexOf(" › "))} › `}
            <Link
              to="/device-profiles/$id"
              params={{ id: parent.id }}
              className="link text-foreground"
            >
              {parent.name}
            </Link>
          </span>
        )
      },
      meta: {
        facet: {
          kind: "enum",
          label: "Parent",
          get: (r: T) => r.parent?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.parent?.name ?? "No parent",
            color: r.parent?.color || undefined,
          }),
          hideWhenSingle: true,
        },
      },
    }),
    applies_to: () => ({
      id: "applies_to",
      accessorFn: (r) => appliesToLabel(r),
      header: ({ column }) => <SortHeader column={column} label="Applies to" />,
      cell: ({ row }) => (
        <span className="whitespace-nowrap text-muted-foreground">
          {appliesToLabel(row.original)}
        </span>
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Applies to",
          get: (r: T) => appliesToLabel(r),
          hideWhenSingle: true,
        },
      },
    }),
    groups: () => ({
      id: "groups",
      accessorFn: (r) => r.application_groups.length,
      header: ({ column }) => (
        <SortHeader column={column} label="Application groups" />
      ),
      cell: ({ row }) => (
        <span className="num">{row.original.application_groups.length}</span>
      ),
      meta: { field: "application_groups" },
    }),
    assigned: () => ({
      id: "assigned",
      accessorKey: "assignment_count",
      header: ({ column }) => <SortHeader column={column} label="Assigned" />,
      cell: ({ row }) => (
        <span className="num">{row.original.assignment_count}</span>
      ),
    }),
    children: () => ({
      id: "children",
      accessorKey: "child_count",
      header: ({ column }) => <SortHeader column={column} label="Children" />,
      cell: ({ row }) => (
        <span className="num">{row.original.child_count}</span>
      ),
      meta: { label: "Children", defaultHidden: true },
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
    tags: () => tagsColumn<T>({ getTags: (r) => r.tags }),
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

// ─── assigned objects ────────────────────────────────────────────────────

/** The devices and VMs a profile is assigned to, with their state. */
export function buildDeviceProfileAssignmentColumns(
  opts: {
    selection?: boolean
    actions?: ActionsColumnOpts<DeviceProfileAssignment>
  } = {}
): ColumnDef<DeviceProfileAssignment, unknown>[] {
  const cols: ColumnDef<DeviceProfileAssignment, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<DeviceProfileAssignment>())
  cols.push(
    {
      id: "host",
      accessorFn: (a) => a.device?.name ?? a.virtual_machine?.name ?? "",
      header: ({ column }) => <SortHeader column={column} label="Object" />,
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
      meta: {
        facet: {
          kind: "enum",
          label: "Kind",
          get: (a: DeviceProfileAssignment) =>
            a.device ? "Device" : "Virtual machine",
          hideWhenSingle: true,
        },
      },
    },
    {
      id: "state",
      accessorFn: (a) => profileStateLabel(a.state),
      header: ({ column }) => <SortHeader column={column} label="State" />,
      cell: ({ row }) => <ProfileStateBadge state={row.original.state} />,
      meta: {
        facet: {
          kind: "enum",
          label: "State",
          get: (a: DeviceProfileAssignment) => profileStateLabel(a.state),
        },
      },
    },
    {
      id: "missing",
      accessorKey: "missing_count",
      header: ({ column }) => <SortHeader column={column} label="Missing" />,
      cell: ({ row }) =>
        row.original.missing_count ? (
          <Badge variant="warning" className="num">
            {row.original.missing_count}
          </Badge>
        ) : (
          <span className="num text-muted-foreground">0</span>
        ),
    },
    {
      id: "edited",
      accessorKey: "edited_count",
      header: ({ column }) => <SortHeader column={column} label="Edited" />,
      cell: ({ row }) =>
        row.original.edited_count ? (
          <Badge variant="info" className="num">
            {row.original.edited_count}
          </Badge>
        ) : (
          <span className="num text-muted-foreground">0</span>
        ),
    },
    timeAgoColumn<DeviceProfileAssignment>({
      id: "assigned",
      header: "Assigned",
      get: (a) => a.created_at,
      align: "right",
    })
  )
  if (opts.actions) cols.push(actionsColumn(opts.actions))
  return cols
}

// ─── on device and VM lists ──────────────────────────────────────────────

/** A device's or VM's profiles as badges, in order; a profile that is out
 * of step carries its state. */
export function HostProfileBadges({
  profiles,
}: {
  profiles: HostDeviceProfile[] | undefined
}) {
  if (!profiles?.length) return dash
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {profiles.map((p) => (
        <span key={p.id} className="inline-flex items-center gap-1">
          <Link
            to="/device-profiles/$id"
            params={{ id: p.id }}
            className="inline-flex"
          >
            <ColorBadge name={p.name} color={p.color || undefined} />
          </Link>
          {p.state !== "ok" && <ProfileStateBadge state={p.state} />}
        </span>
      ))}
    </span>
  )
}

/** The hidden "Profiles" column of the device and VM lists. */
export function deviceProfilesColumn<
  T extends { device_profiles?: HostDeviceProfile[] },
>(): ColumnDef<T, unknown> {
  return {
    id: "device_profiles",
    accessorFn: (r) => (r.device_profiles ?? []).map((p) => p.name).join(", "),
    header: ({ column }) => <SortHeader column={column} label="Profiles" />,
    cell: ({ row }) => (
      <HostProfileBadges profiles={row.original.device_profiles} />
    ),
    meta: {
      label: "Profiles",
      defaultHidden: true,
      field: "device_profiles",
      export: {
        header: "Profiles",
        value: (r) => (r.device_profiles ?? []).map((p) => p.name).join(", "),
      },
    },
  }
}
