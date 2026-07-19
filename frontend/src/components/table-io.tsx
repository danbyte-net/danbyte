import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ArrowDownUp, ChevronDown, Upload } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  ioExportUrl,
  ioImport,
  type IOFormat,
  type IOTypeMeta,
  type ImportResult,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiErrorToast } from "@/lib/api-toast"

/**
 * The round-trip *data* export/import control — distinct from the pretty
 * `Export` dropdown (share with a colleague). Exports include ids + stable keys
 * so the file can be edited and re-uploaded to update rows. Renders nothing
 * unless the backend reports this type as IO-capable for the user.
 */
export function TableIO({
  slug,
  name,
  selectedIds = [],
  exportFilter,
  prominent = false,
}: {
  slug: string
  name?: string
  selectedIds?: string[]
  /** Narrow the export by model field, e.g. `{ prefix: id }` to export only a
   * prefix's IPs. */
  exportFilter?: Record<string, string>
  /** Render as a full-size header button ("Import / Export") rather than the
   * compact toolbar control. Use in page headers next to "Add …". */
  prominent?: boolean
}) {
  const [importing, setImporting] = useState(false)
  const types = useQuery({
    queryKey: ["io-types"],
    queryFn: () =>
      api<{ object_types: IOTypeMeta[] }>("/api/io/types/").then(
        (r) => r.object_types
      ),
    staleTime: 5 * 60_000,
  })
  const meta = types.data?.find((t) => t.slug === slug)
  if (!meta || (!meta.can_export && !meta.can_import)) return null

  const ids = selectedIds.length ? selectedIds : undefined
  const fmts: [IOFormat, string][] = [
    ["csv", "CSV (.csv)"],
    ["xlsx", "Excel (.xlsx)"],
    ["json", "JSON (.json)"],
  ]

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {prominent ? (
            <Button variant="outline" size="sm">
              <ArrowDownUp className="h-3.5 w-3.5" />
              Import / Export
              {ids && (
                <span className="ml-1 text-muted-foreground">
                  ({ids.length})
                </span>
              )}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          ) : (
            <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
              <ArrowDownUp className="mr-1 h-3 w-3" />
              Data
              {ids && (
                <span className="ml-1 text-muted-foreground">
                  ({ids.length})
                </span>
              )}
              <ChevronDown className="ml-1 h-3 w-3" />
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {meta.can_export && (
            <>
              <DropdownMenuLabel className="text-[10px] tracking-wider uppercase">
                Export {ids ? `${ids.length} selected` : "all rows"}
              </DropdownMenuLabel>
              {fmts.map(([fmt, label]) => (
                <DropdownMenuItem key={fmt} asChild>
                  <a
                    href={ioExportUrl(slug, { fmt, ids, filter: exportFilter })}
                    download
                  >
                    {label}
                  </a>
                </DropdownMenuItem>
              ))}
            </>
          )}
          {meta.can_import && (
            <>
              {meta.can_export && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => setImporting(true)}>
                <Upload className="h-3.5 w-3.5" /> Import…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <TableIODialog
        slug={slug}
        name={name}
        naturalKey={meta.natural_key}
        open={importing}
        onOpenChange={setImporting}
      />
    </>
  )
}

function TableIODialog({
  slug,
  name,
  naturalKey,
  open,
  onOpenChange,
}: {
  slug: string
  name?: string
  naturalKey: string[]
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<ImportResult | null>(null)

  const reset = () => {
    setFile(null)
    setResult(null)
    if (inputRef.current) inputRef.current.value = ""
  }

  async function run(f: File, dry_run: boolean): Promise<ImportResult> {
    const ext = f.name.split(".").pop()?.toLowerCase()
    if (ext === "xlsx") return ioImport(slug, { file: f, dry_run })
    const content = await f.text()
    const format = ext === "json" ? "json" : "csv"
    return ioImport(slug, { format, content, dry_run })
  }

  const preview = useMutation({
    mutationFn: (f: File) => run(f, true),
    onSuccess: setResult,
    onError: (e) => apiErrorToast(e),
  })
  const apply = useMutation({
    mutationFn: (f: File) => run(f, false),
    onSuccess: (r) => {
      qc.invalidateQueries()
      toast.success(
        `Imported — ${r.created ?? 0} created, ${r.updated ?? 0} updated` +
          (r.errors.length ? `, ${r.errors.length} failed` : "")
      )
      if (!r.errors.length) {
        reset()
        onOpenChange(false)
      } else {
        setResult(r) // keep dialog open to show remaining errors
      }
    },
    onError: (e) => apiErrorToast(e),
  })

  const onPick = (f: File | null) => {
    setFile(f)
    setResult(null)
    if (f) preview.mutate(f)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import {name ?? slug}</DialogTitle>
          <DialogDescription>
            Upload a CSV, Excel, or JSON file. Rows are matched by{" "}
            <span className="font-mono text-[11px]">id</span>
            {naturalKey.length > 0 && (
              <>
                {" "}
                (or{" "}
                <span className="font-mono text-[11px]">
                  {naturalKey.join(" + ")}
                </span>
                )
              </>
            )}{" "}
            to update existing rows; new rows are created. Tip: export first to
            get the exact columns.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <input
            ref={inputRef}
            type="file"
            accept=".csv,.json,.xlsx"
            onChange={(e) => onPick(e.target.files?.[0] ?? null)}
            className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs"
          />

          {preview.isPending && (
            <p className="text-xs text-muted-foreground">Checking file…</p>
          )}

          {result && (
            <div className="rounded-md border border-border p-3 text-xs">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>
                  <b className="num">{result.created ?? 0}</b> to create
                </span>
                <span>
                  <b className="num">{result.updated ?? 0}</b> to update
                </span>
                <span
                  className={
                    result.errors.length
                      ? "text-destructive"
                      : "text-muted-foreground"
                  }
                >
                  <b className="num">{result.errors.length}</b> error
                  {result.errors.length === 1 ? "" : "s"}
                </span>
                {result.dry_run && (
                  <span className="text-muted-foreground">· preview</span>
                )}
              </div>

              {result.errors.length > 0 && (
                <ul className="mt-2 max-h-40 space-y-0.5 overflow-auto">
                  {result.errors.slice(0, 50).map((e, i) => (
                    <li key={i} className="text-destructive">
                      Row {e.row}: {e.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!file || apply.isPending || preview.isPending}
              onClick={() => file && apply.mutate(file)}
            >
              {apply.isPending ? "Importing…" : "Apply import"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
