import * as React from "react"

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
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
 * {@link DataTable} — rounded bordered container, canonical header/row/cell
 * styling, central hover — but *without* the toolbar (sort, Columns menu,
 * Export). Use it for embedded tables (device SNMP tab, reconcile inbox) so
 * they look identical to the list-page tables without dragging a per-card
 * toolbar into every section.
 */
export function SimpleTable<T>({
  columns,
  data,
  getRowKey,
  empty = "No results.",
}: {
  columns: SimpleColumn<T>[]
  data: T[]
  getRowKey: (row: T, index: number) => React.Key
  empty?: React.ReactNode
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
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
            data.map((row, i) => (
              <TableRow key={getRowKey(row, i)}>
                {columns.map((c) => (
                  <TableCell
                    key={c.id}
                    className={cn(
                      "py-2 text-sm",
                      c.flex ? "w-full max-w-0 truncate" : "whitespace-nowrap",
                      c.align === "right" && "text-right",
                      c.className
                    )}
                  >
                    {c.cell(row, i)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : (
            <TableRow>
              <TableCell
                colSpan={columns.length}
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
