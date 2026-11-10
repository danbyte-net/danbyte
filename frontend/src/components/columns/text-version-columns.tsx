import type { ColumnDef } from "@tanstack/react-table"

import type { TextVersion } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { SortHeader, selectionColumn } from "@/components/data-table"
import { TimeCell } from "@/components/cells/time-ago"

// The one source of truth for "a table of saved body versions" (#465) - the
// Versions tab of export templates and scripts, and the label templates'
// versions dialog. The checkbox picks the versions to compare.

export type TextVersionColumnId =
  "at" | "by" | "lines" | "size" | "sha" | "cause"

const CANONICAL_ORDER: TextVersionColumnId[] = [
  "at",
  "by",
  "lines",
  "size",
  "sha",
  "cause",
]

function bytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export interface TextVersionColumnOpts {
  omit?: TextVersionColumnId[]
  selection?: boolean
  /** The live text's hash: that row gets a Current badge. */
  currentSha?: string | null
}

export function buildTextVersionColumns(
  opts: TextVersionColumnOpts = {}
): ColumnDef<TextVersion, unknown>[] {
  const omit = new Set(opts.omit ?? [])
  const byId: Record<
    TextVersionColumnId,
    () => ColumnDef<TextVersion, unknown>
  > = {
    at: () => ({
      id: "at",
      accessorFn: (r) => r.at ?? "",
      header: ({ column }) => <SortHeader column={column} label="Saved" />,
      cell: ({ row }) => (
        <span className="flex items-center gap-2 whitespace-nowrap">
          {row.original.at ? <TimeCell iso={row.original.at} /> : "-"}
          {row.original.action === "create" && (
            <Badge variant="outline">Created</Badge>
          )}
          {opts.currentSha && row.original.sha256 === opts.currentSha && (
            <Badge variant="secondary">Current</Badge>
          )}
        </span>
      ),
    }),
    by: () => ({
      id: "by",
      accessorFn: (r) => r.by,
      header: ({ column }) => <SortHeader column={column} label="By" />,
      cell: ({ row }) =>
        row.original.by || (
          <span className="text-muted-foreground">system</span>
        ),
    }),
    lines: () => ({
      id: "lines",
      accessorFn: (r) => r.lines ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Lines" />,
      cell: ({ row }) =>
        row.original.lines == null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <span className="num">{row.original.lines}</span>
        ),
    }),
    size: () => ({
      id: "size",
      accessorFn: (r) => r.size ?? -1,
      header: ({ column }) => <SortHeader column={column} label="Size" />,
      cell: ({ row }) =>
        row.original.size == null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          <span className="num">{bytes(row.original.size)}</span>
        ),
    }),
    sha: () => ({
      id: "sha",
      header: "SHA-256",
      cell: ({ row }) =>
        row.original.text_kept ? (
          <span className="font-mono text-xs text-muted-foreground">
            {row.original.sha256?.slice(0, 12)}
          </span>
        ) : (
          <Badge variant="warning">Text not kept</Badge>
        ),
    }),
    cause: () => ({
      id: "cause",
      accessorFn: (r) => r.cause,
      header: "Cause",
      cell: ({ row }) => (
        <span className="text-muted-foreground">{row.original.cause}</span>
      ),
    }),
  }
  const cols: ColumnDef<TextVersion, unknown>[] = []
  if (opts.selection) cols.push(selectionColumn<TextVersion>())
  for (const id of CANONICAL_ORDER) if (!omit.has(id)) cols.push(byId[id]())
  return cols
}
