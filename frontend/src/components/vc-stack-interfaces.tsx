import { useMemo } from "react"
import { useQueries } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"

import {
  api,
  type Interface,
  type Paginated,
  type VirtualChassisMember,
} from "@/lib/api"
import { DataTable } from "@/components/data-table"
import {
  buildInterfaceActionsColumn,
  buildInterfaceColumns,
  nestInterfaces,
  type InterfaceActionsOpts,
  type NestedInterface,
} from "@/components/columns/interface-columns"
import { cableTint } from "@/components/cable-status-control"
import { QueryError } from "@/components/query-error"

export interface StackInterfaceRow {
  member: VirtualChassisMember
  /** Carries `_depth` so sub-interfaces indent under their parent, exactly as
   * they do in the per-device table. */
  iface: NestedInterface
}

/** Every member's interfaces, flattened in stack order (member position,
 * then numeric-aware interface name). One query per member; results are
 * cached under ["vc-member-interfaces", <device id>] so the VC page and the
 * device page share fetches. */
export function useStackInterfaces(members: VirtualChassisMember[]): {
  rows: StackInterfaceRow[]
  count: number | undefined
  loading: boolean
  error: Error | null
} {
  const queries = useQueries({
    queries: members.map((m) => ({
      queryKey: ["vc-member-interfaces", m.id],
      queryFn: () =>
        api<Paginated<Interface>>(
          `/api/interfaces/?device=${m.id}&page_size=500`
        ),
    })),
  })
  const loading = queries.some((q) => q.isLoading)
  const error = (queries.find((q) => q.isError)?.error as Error) ?? null
  const rows = loading
    ? []
    : members.flatMap((m, i) =>
        // Name-sort, then nest PER MEMBER (a parent interface always belongs to
        // the same device), so each child follows its parent and carries a depth
        // — the same hierarchy the per-device table renders.
        nestInterfaces(
          [...(queries[i].data?.results ?? [])].sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true })
          )
        ).map((iface) => ({ member: m, iface }))
      )
  return {
    rows,
    count: loading || error ? undefined : rows.length,
    loading,
    error,
  }
}

/** A stack interface row carrying its owning member, so the shared interface
 * columns (which operate on an interface) can render alongside a Member column. */
type StackRow = NestedInterface & { _member: VirtualChassisMember }

/** The combined whole-stack interfaces table. Renders the SAME rich interface
 * columns as the per-device "This member" table (shared `buildInterfaceColumns`),
 * with a Member column in front — so the two views stay identical.
 * `highlightMemberId` tints the rows of one member (the device page uses it to
 * anchor "you are here"). */
export function StackInterfacesTable({
  rows,
  loading,
  error,
  highlightMemberId,
  actions,
}: {
  rows: StackInterfaceRow[]
  loading: boolean
  error: Error | null
  highlightMemberId?: string
  /** Row actions, identical to the per-device table's. Omit `deviceIdFor` — the
   * stack table resolves the owning member per row. Leave unset to render the
   * table read-only. */
  actions?: Omit<InterfaceActionsOpts<StackRow>, "deviceIdFor">
}) {
  // `iface` already carries its `_depth` from useStackInterfaces — don't flatten
  // it, or sub-interfaces lose the indentation the per-device table shows.
  const data = useMemo<StackRow[]>(
    () => rows.map(({ member, iface }) => ({ ...iface, _member: member })),
    [rows]
  )
  // Destructured so the columns memo keys off the primitive flags + the (stable)
  // setState callbacks rather than the `actions` object's identity — callers pass
  // a fresh object each render.
  const {
    canAddIp = false,
    canAssignIp = false,
    canEdit = false,
    canChangeCable = false,
    canConnect = false,
    onTrace,
    onAssignIp,
  } = actions ?? {}
  const columns = useMemo<ColumnDef<StackRow>[]>(() => {
    const actionsCol =
      onTrace && onAssignIp
        ? buildInterfaceActionsColumn<StackRow>({
            canAddIp,
            canAssignIp,
            canEdit,
            canChangeCable,
            canConnect,
            onTrace,
            onAssignIp,
            // Each row belongs to its own member device.
            deviceIdFor: (r) => r._member.id,
          })
        : null
    return [
      {
        id: "member",
        header: "Member",
        cell: ({ row }) => {
          const m = row.original._member
          return (
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span className="num inline-flex h-5 w-5 items-center justify-center rounded-sm border border-border text-[11px] text-muted-foreground">
                {m.vc_position ?? "—"}
              </span>
              <Link
                to="/devices/$id"
                params={{ id: m.id }}
                className="font-mono text-[13px] text-primary hover:underline"
              >
                {m.name}
              </Link>
            </span>
          )
        },
      },
      // The identical interface columns + row actions used by the per-device
      // table. Widened to StackRow (a superset of NestedInterface) — the cells
      // only read interface fields, so this is safe.
      ...(buildInterfaceColumns() as ColumnDef<StackRow>[]),
      ...(actionsCol ? [actionsCol] : []),
    ]
  }, [
    canAddIp,
    canAssignIp,
    canEdit,
    canChangeCable,
    canConnect,
    onTrace,
    onAssignIp,
  ])

  if (error) return <QueryError error={error} />
  if (loading) return <p className="text-sm text-muted-foreground">Loading…</p>
  if (data.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        No interfaces on any member.
      </p>
    )

  return (
    <DataTable
      data={data}
      columns={columns}
      // "You are here" is an inset left accent bar, NOT a background: zebra
      // striping is a background on the same <tr> (styles.css, components
      // layer), so a `bg-*` utility here would override it and flatten the
      // current member's rows. A shadow composes with both the stripe and the
      // cable tint, and doesn't shift layout.
      rowClassName={(r) =>
        highlightMemberId && r._member.id === highlightMemberId
          ? "shadow-[inset_2px_0_0_var(--primary)]"
          : undefined
      }
      rowStyle={(r) => cableTint(r.cable?.status)}
      embedded
    />
  )
}
