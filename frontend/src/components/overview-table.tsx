import * as React from "react"

import { TableScrollProxy, useTableScroll } from "@/components/table-scroll"
import { Section } from "@/components/ui/section"
import type { SimpleColumn } from "@/components/ui/simple-table"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

/**
 * A small table on a detail page's Overview, in the same chrome as
 * {@link KvCard}: the uppercase section heading, a rounded bordered card,
 * striped rows, the card's type sizes. No toolbar, row count or page size.
 * The last column takes the spare width, so the columns read left to right
 * instead of spreading to the far edge.
 */
export function OverviewTable<T>({
  title,
  count,
  badge,
  columns,
  data,
  getRowKey,
  footer,
  actions,
}: {
  title: React.ReactNode
  count?: number
  badge?: React.ReactNode
  columns: SimpleColumn<T>[]
  data: T[]
  getRowKey: (row: T, index: number) => React.Key
  /** Under the card: a "View all" link, a hidden-rows note. */
  footer?: React.ReactNode
  /** Right of the heading: the card's own action (Apply profile). */
  actions?: React.ReactNode
}) {
  const last = columns.length - 1
  const width = (i: number) => (i === last ? "w-full" : "whitespace-nowrap")
  const hscroll = useTableScroll()
  return (
    <Section title={title} count={count} badge={badge} actions={actions}>
      {/* A wide table scrolls sideways with a floating scrollbar and edge
          shadows, as DataTable does (table-scroll.tsx). */}
      <div
        ref={hscroll.frameRef}
        className="relative overflow-hidden rounded-lg border border-border bg-card"
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((c, i) => (
                <TableHead
                  key={c.id}
                  className={cn(
                    "h-8 text-xs text-muted-foreground",
                    width(i),
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
            {data.map((row, r) => (
              <TableRow
                key={getRowKey(row, r)}
                className={r % 2 === 1 ? "bg-muted/30" : undefined}
              >
                {columns.map((c, i) => (
                  <TableCell
                    key={c.id}
                    className={cn(
                      "py-2 text-[13px] text-foreground",
                      width(i),
                      c.align === "right" && "text-right",
                      c.className
                    )}
                  >
                    {c.cell(row, r)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <TableScrollProxy scroll={hscroll} />
      {footer && <div className="mt-1.5 text-xs">{footer}</div>}
    </Section>
  )
}
