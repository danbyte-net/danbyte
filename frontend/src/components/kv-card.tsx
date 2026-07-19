import * as React from "react"
import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { toast } from "sonner"

import { copyText } from "@/lib/clipboard"
import { dash } from "@/components/cells/dash"
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table"

export { dash } from "@/components/cells/dash"

/** Render a value in monospace, or the dash when empty. */
export function mono(v: string | null | undefined): React.ReactNode {
  return v ? <span className="font-mono text-[13px]">{v}</span> : dash
}

export interface KvRow {
  label: string
  value: React.ReactNode
  /** When set, a copy-to-clipboard button is shown at the end of the row. */
  copy?: string
}

/**
 * Labelled field table — a titled, bordered, zebra-striped table
 * of label/value rows, with an optional per-row copy button. Shared by the
 * Device and VM (and future) detail "Overview" tabs so they look identical.
 */
export function KvCard({ title, rows }: { title: string; rows: KvRow[] }) {
  return (
    <section>
      <h2 className="mb-2 text-[11px] font-semibold tracking-wide text-foreground uppercase">
        {title}
      </h2>
      <div className="overflow-hidden rounded-lg border border-border">
        <Table>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow
                key={r.label}
                className={i % 2 === 1 ? "bg-muted/30" : undefined}
              >
                <TableCell className="w-40 py-2 align-top text-xs text-muted-foreground">
                  {r.label}
                </TableCell>
                <TableCell className="py-2 text-[13px] text-foreground">
                  {r.value}
                </TableCell>
                <TableCell className="w-9 py-2 pr-2 text-right align-top">
                  {r.copy ? <CopyButton value={r.copy} /> : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </section>
  )
}

export function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  // Nothing to copy → render nothing, so direct callers can pass a maybe-empty
  // string without guarding.
  if (!value) return null
  return (
    <button
      type="button"
      onClick={async () => {
        const ok = await copyText(value)
        if (!ok) {
          toast.error("Couldn't copy — clipboard blocked by the browser")
          return
        }
        setDone(true)
        window.setTimeout(() => setDone(false), 1200)
      }}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
      title={done ? "Copied" : `Copy ${value}`}
      aria-label={`Copy ${value}`}
    >
      {done ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}
