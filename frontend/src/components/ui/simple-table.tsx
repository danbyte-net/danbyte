import * as React from "react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

export interface SimpleColumn<T> {
  /** Stable id (used as the React key for header/cells). */
  id: string
  header: React.ReactNode
  cell: (row: T, index: number) => React.ReactNode
  /** Absorb the extra horizontal space (CLAUDE.md elastic-column pattern). */
  flex?: boolean
  /** Right-align the column (numbers, actions). */
  align?: "right"
  /** Extra classes for both the header cell and body cells. */
  className?: string
}

/**
 * A read-only table that reproduces the exact chrome of the shared
 * {@link DataTable} - rounded bordered container, canonical header/row/cell
 * styling, central hover - but *without* the toolbar (sort, Columns menu,
 * Export). Use it for embedded tables (device SNMP tab, reconcile inbox) so
 * they look identical to the list-page tables without dragging a per-card
 * toolbar into every section.
 */
export function SimpleTable<T>({
  columns,
  data,
  getRowKey,
  empty = "No results.",
  renderExpanded,
}: {
  columns: SimpleColumn<T>[]
  data: T[]
  getRowKey: (row: T, index: number) => React.Key
  empty?: React.ReactNode
  /** Rows open: a chevron column appears, and the row's own content is
   * rendered under it when opened. One row open at a time. */
  renderExpanded?: (row: T, index: number) => React.ReactNode
}) {
  const [open, setOpen] = React.useState<React.Key | null>(null)
  const span = columns.length + (renderExpanded ? 1 : 0)
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            {renderExpanded && <TableHead className="w-8" />}
            {columns.map((c) => (
              <TableHead
                key={c.id}
                className={cn(
                  "text-xs",
                  c.flex ? "w-full" : "whitespace-nowrap",
                  c.align === "right" && "text-right",
                  c.className
                )}
              >
                {c.header}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.length ? (
            data.map((row, i) => {
              const key = getRowKey(row, i)
              const isOpen = renderExpanded !== undefined && open === key
              return (
                <React.Fragment key={key}>
                  <TableRow
                    className={renderExpanded ? "cursor-pointer" : undefined}
                    onClick={
                      renderExpanded
                        ? () => setOpen(isOpen ? null : key)
                        : undefined
                    }
                  >
                    {renderExpanded && (
                      <TableCell className="w-8 py-2 pr-0">
                        <ChevronRight
                          className={cn(
                            "h-3.5 w-3.5 text-muted-foreground transition-transform",
                            isOpen && "rotate-90"
                          )}
                        />
                      </TableCell>
                    )}
                    {columns.map((c) => (
                      <TableCell
                        key={c.id}
                        className={cn(
                          "py-2 text-sm",
                          c.flex
                            ? "w-full max-w-0 truncate"
                            : "whitespace-nowrap",
                          c.align === "right" && "text-right",
                          c.className
                        )}
                      >
                        {c.cell(row, i)}
                      </TableCell>
                    ))}
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={span} className="bg-muted/30 py-3">
                        {renderExpanded(row, i)}
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              )
            })
          ) : (
            <TableRow>
              <TableCell
                colSpan={span}
                className="h-16 text-center text-sm text-muted-foreground"
              >
                {empty}
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}
