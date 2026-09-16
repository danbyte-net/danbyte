import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRight, Download } from "lucide-react"

import { apiText, formatBytes } from "@/lib/api"
import type { ScriptOutput } from "@/lib/api"
import { parseCsv } from "@/lib/csv-parse"
import { Button } from "@/components/ui/button"
import { QueryError } from "@/components/query-error"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"

// Fetching a file to render it is only reasonable while it is small; past
// this the download is the answer.
const PREVIEW_LIMIT = 2_000_000
const MAX_ROWS = 500

type Kind = "csv" | "json" | "text" | "none"

function kindOf(output: ScriptOutput): Kind {
  const name = output.name.toLowerCase()
  const type = (output.content_type || "").toLowerCase()
  if (name.endsWith(".csv") || type.includes("csv")) return "csv"
  if (name.endsWith(".json") || type.includes("json")) return "json"
  if (
    type.startsWith("text/") ||
    /\.(txt|log|md|yaml|yml|xml|ini|conf)$/.test(name)
  ) {
    return "text"
  }
  return "none"
}

/** One file a run produced: what it is, and what is in it.
 *
 * A CSV is the usual output of a reporting script, and a row count plus a
 * download button is not an answer - so it renders as the same table the
 * rest of the product uses, with the download still there for the copy you
 * keep. */
export function ScriptOutputCard({
  runId,
  output,
  defaultOpen,
}: {
  runId: string
  output: ScriptOutput
  defaultOpen: boolean
}) {
  const kind = kindOf(output)
  const previewable = kind !== "none" && output.size <= PREVIEW_LIMIT
  const [open, setOpen] = useState(defaultOpen && previewable)
  const href = `/api/scripts/runs/${runId}/outputs/${output.id}/download/`

  const content = useQuery({
    queryKey: ["script-output", output.id],
    queryFn: () => apiText(href),
    enabled: open && previewable,
    staleTime: Infinity,
  })

  return (
    <section className="rounded-lg border border-border">
      <header className="flex items-center gap-2 px-3 py-2">
        {previewable ? (
          <button
            type="button"
            onClick={() => setOpen((was) => !was)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
            aria-expanded={open}
          >
            <ChevronRight
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                open && "rotate-90"
              )}
            />
            <span className="truncate text-sm font-medium">{output.name}</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {output.name}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground">
          {output.content_type || "file"} · {formatBytes(output.size)}
        </span>
        <Button size="sm" variant="ghost" asChild>
          <a href={href} download>
            <Download className="size-3.5" /> Download
          </a>
        </Button>
      </header>

      {open && (
        <div className="border-t border-border p-3">
          {content.isPending ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : content.error ? (
            <QueryError error={content.error} />
          ) : kind === "csv" ? (
            <CsvTable text={content.data} />
          ) : (
            <pre className="max-h-96 overflow-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs">
              {kind === "json" ? pretty(content.data) : content.data}
            </pre>
          )}
        </div>
      )}
    </section>
  )
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** The CSV as a table. The first row is the header - `run.output_csv`
 * always writes one. */
function CsvTable({ text }: { text: string }) {
  const rows = parseCsv(text, MAX_ROWS + 1)
  if (rows.length === 0) {
    return <p className="text-xs text-muted-foreground">The file is empty.</p>
  }
  const [header, ...body] = rows
  const shown = body.slice(0, MAX_ROWS)
  return (
    <>
      <div className="max-h-96 overflow-auto rounded-lg border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {header.map((h, i) => (
                <TableHead key={i} className="text-xs whitespace-nowrap">
                  {h}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row, i) => (
              <TableRow key={i}>
                {header.map((_, c) => (
                  <TableCell key={c} className="whitespace-nowrap">
                    {row[c] ?? ""}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {body.length > MAX_ROWS
          ? `First ${MAX_ROWS} of ${body.length} rows. Download for the rest.`
          : `${body.length} row${body.length === 1 ? "" : "s"}.`}
      </p>
    </>
  )
}
