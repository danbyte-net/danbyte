import type { ColumnDef } from "@tanstack/react-table"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowLeftRight, ChevronDown } from "lucide-react"

import { api } from "@/lib/api"
import type { Cable, Paginated, Status, Termination } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { fiberColor } from "@/lib/fiber"
import { selectionColumn } from "@/components/data-table"
import { StatusBadge } from "@/components/status-badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { dash } from "@/components/cells/dash"
import { numidColumn } from "@/components/cells/numid"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"

// The one source of truth for "a table of cables". Every surface that lists
// cables — /cables and /fiber-cables — builds its columns here so a cable row
// reads identically everywhere. Page-specific columns (the /cables trace +
// row-actions pair, which wraps two controls in its own flex row) are spliced
// around this factory's output; the shared cells are never re-authored inline.
//
// Facet meta (useTableFilters) is attached where it makes sense; pages that
// don't render a facet rail simply ignore it.
//
// "strands"/"labelled" only mean anything for optical fibre, so /cables omits
// them; /fiber-cables omits "description" in their place.

/** "device:port, device:port" for one end of a run — em dash when uncabled. */
export function termSummary(terms: Termination[]): string {
  if (!terms.length) return "—"
  return terms.map((t) => `${t.device.name}:${t.name}`).join(", ")
}

// Inline status control: click the badge to switch a cable between its
// available statuses (Connected / Planned / Decommissioning) without opening
// the edit form. Falls back to a plain badge when the user can't edit.
function CableStatusCell({
  cable,
  canEdit,
}: {
  cable: Cable
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const statuses = useQuery({
    queryKey: ["statuses", "cable"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=cable&picker=1"),
    enabled: canEdit,
    staleTime: 5 * 60_000,
  })
  const setStatus = useMutation({
    mutationFn: (statusId: string) =>
      api<Cable>(`/api/cables/${cable.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ status_id: statusId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cables"] }),
    onError: (e: unknown) => apiErrorToast(e, "Could not change status"),
  })
  if (!canEdit) return <StatusBadge status={cable.status} />
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md hover:bg-muted/60"
          onClick={(e) => e.stopPropagation()}
          title="Change cable status"
        >
          <StatusBadge status={cable.status} />
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {(statuses.data?.results ?? []).map((s) => (
          <DropdownMenuItem
            key={s.id}
            disabled={setStatus.isPending || s.id === cable.status?.id}
            onSelect={() => setStatus.mutate(s.id)}
          >
            <span
              className="mr-2 h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Strand-count buckets for the filter rail. */
function countBucket(n: number | null): string {
  if (!n) return "__none__"
  if (n <= 2) return "2"
  if (n <= 12) return "12"
  if (n <= 24) return "24"
  if (n <= 48) return "48"
  if (n <= 96) return "96"
  return "144+"
}

function labelledCount(c: Cable): number {
  return Object.values(c.strands).filter((s) => s.label || s.status).length
}

/** A compact colour strip previewing the first few strands. */
function StrandPreview({ cable }: { cable: Cable }) {
  const n = cable.fiber_count ?? 0
  if (!n) return <span className="text-muted-foreground">—</span>
  const shown = Math.min(n, 8)
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="flex">
        {Array.from({ length: shown }, (_, i) => (
          <span
            key={i}
            className="h-3 w-1.5 first:rounded-l-sm last:rounded-r-sm"
            style={{ backgroundColor: fiberColor(i + 1).hex }}
          />
        ))}
      </span>
      <span className="num text-xs tabular-nums">{n}</span>
    </span>
  )
}

export type CableColumnId =
  | "numid"
  | "label"
  | "a"
  | "link"
  | "b"
  | "type"
  | "strands"
  | "labelled"
  | "status"
  | "description"
  | "tags"
  | "updated"

const CANONICAL_ORDER: CableColumnId[] = [
  "numid",
  "label",
  "a",
  "link",
  "b",
  "type",
  "strands",
  "labelled",
  "status",
  "description",
  "tags",
  "updated",
]

export interface CableColumnOpts {
  /** Drop columns (e.g. /cables omits the fibre-only "strands"/"labelled"). */
  omit?: CableColumnId[]
  /** Keep only these columns (canonical order still applies). */
  include?: CableColumnId[]
  /** Leading checkbox column for bulk selection. */
  selection?: boolean
  /** Leading "#" numid column — gate on `useMe().humanIds`. */
  humanIds?: boolean
  /** Label cell rendering:
   * - "strict" (default): the label as a medium-weight link, em dash when
   *   blank — an unlabelled cable on /cables is identified by its ends.
   * - "numbered": always a link, falling back to a muted "Cable #n" — the
   *   fibre list, where labels are often unset but every run needs opening. */
  labelVariant?: "strict" | "numbered"
  /** Link the A/B termination summaries to the cable (default true). */
  terminationsLinked?: boolean
  /** Render Status as the inline switcher instead of a plain badge — pass the
   * caller's `cable:change` permission, not a bare `true`. */
  statusEditable?: boolean
  /** Wire tag chips to a page-level tag filter (defaults to inert). */
  tagFilter?: { activeSlugs: Set<string>; onToggle: (slug: string) => void }
}

export function buildCableColumns(
  opts: CableColumnOpts = {}
): ColumnDef<Cable, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  // The "#" column only exists where the deployment enables human ids.
  if (!opts.humanIds) omit.add("numid")
  const keep = (id: CableColumnId) =>
    !omit.has(id) && (!opts.include || opts.include.includes(id))

  const linked = opts.terminationsLinked ?? true

  const termColumn = (
    id: "a" | "b",
    header: string,
    get: (c: Cable) => Termination[]
  ): ColumnDef<Cable, unknown> => ({
    id,
    header,
    enableSorting: false,
    cell: ({ row }) =>
      linked ? (
        <Link
          to="/cables/$id"
          params={{ id: row.original.id }}
          className="link font-mono text-xs"
        >
          {termSummary(get(row.original))}
        </Link>
      ) : (
        <span className="font-mono text-xs">
          {termSummary(get(row.original))}
        </span>
      ),
  })

  const byId: Record<CableColumnId, () => ColumnDef<Cable, unknown>> = {
    numid: () => numidColumn<Cable>({ get: (r) => r.numid }),
    label: () => ({
      id: "label",
      accessorKey: "label",
      header: "Label",
      cell: ({ row }) =>
        opts.labelVariant === "numbered" ? (
          <Link
            to="/cables/$id"
            params={{ id: row.original.id }}
            className="link text-xs"
          >
            {row.original.label || (
              <span className="text-muted-foreground">
                Cable #{row.original.numid}
              </span>
            )}
          </Link>
        ) : row.original.label ? (
          <Link
            to="/cables/$id"
            params={{ id: row.original.id }}
            className="link text-xs font-medium"
          >
            {row.original.label}
          </Link>
        ) : (
          dash
        ),
    }),
    a: () => termColumn("a", "A side", (c) => c.a_terminations),
    link: () => ({
      id: "link",
      header: "",
      enableSorting: false,
      cell: () => (
        <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
      ),
    }),
    b: () => termColumn("b", "B side", (c) => c.b_terminations),
    type: () => ({
      id: "type",
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) =>
        row.original.type ? (
          <span className="text-xs">{row.original.type_display}</span>
        ) : (
          dash
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: Cable) => r.type || "__none__",
          formatValue: (v, sample) => ({
            label: v === "__none__" ? "—" : sample.type_display || v,
          }),
        },
      },
    }),
    strands: () => ({
      id: "strands",
      accessorFn: (r) => r.fiber_count ?? 0,
      header: "Strands",
      cell: ({ row }) => <StrandPreview cable={row.original} />,
      meta: {
        facet: {
          kind: "enum",
          label: "Strand count",
          get: (r: Cable) => countBucket(r.fiber_count),
          formatValue: (v) => ({
            label: v === "__none__" ? "Not set" : v,
          }),
        },
      },
    }),
    labelled: () => ({
      id: "labelled",
      accessorFn: (r) => labelledCount(r),
      header: "Labelled",
      cell: ({ row }) => {
        const l = labelledCount(row.original)
        return l ? <span className="num text-xs tabular-nums">{l}</span> : dash
      },
    }),
    status: () => ({
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
      cell: ({ row }) =>
        opts.statusEditable ? (
          <CableStatusCell cable={row.original} canEdit />
        ) : (
          <StatusBadge status={row.original.status} />
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: Cable) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    }),
    description: () => ({
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    }),
    tags: () =>
      tagsColumn<Cable>({
        getTags: (r) => r.tags,
        activeSlugs: opts.tagFilter?.activeSlugs,
        onToggle: opts.tagFilter?.onToggle,
      }),
    updated: () =>
      timeAgoColumn<Cable>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
  }

  const cols: ColumnDef<Cable, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<Cable>())
  for (const id of CANONICAL_ORDER) if (keep(id)) cols.push(byId[id]())
  return cols
}
