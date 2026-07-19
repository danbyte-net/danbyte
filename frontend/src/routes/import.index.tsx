import { createFileRoute } from "@tanstack/react-router"
import { useMemo, useRef, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { CheckCircle2, Upload } from "lucide-react"

import {
  api,
  ioFields,
  ioImport,
  type IOTypeMeta,
  type ImportResult,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Badge } from "@/components/ui/badge"
import { DataTable } from "@/components/data-table"
import { Field, FormSelect, type SelectOption } from "@/components/forms"

export const Route = createFileRoute("/import/")({ component: ImportPage })

type Format = "csv" | "json"
type ImportError = ImportResult["errors"][number]

// Read-only preview of rows the importer rejected. Built once — the shape is
// always { row, error } — so the columns are derived rather than hand-rolled,
// keeping every table in the app on the shared DataTable.
const errorColumns: ColumnDef<ImportError, unknown>[] = [
  {
    id: "row",
    accessorKey: "row",
    header: "Row",
    cell: ({ row }) => (
      <span className="font-mono tabular-nums">{row.original.row}</span>
    ),
  },
  {
    id: "error",
    accessorKey: "error",
    header: "Error",
    // Rejected rows are a danger state — tint the message so invalid cells
    // read at a glance.
    cell: ({ row }) => (
      <span className="text-red-700 dark:text-red-300">
        {row.original.error}
      </span>
    ),
  },
]

function ImportPage() {
  const { isLoading } = useMe()
  const [objectType, setObjectType] = useState<string | null>(null)
  const [format, setFormat] = useState<Format>("csv")
  const [content, setContent] = useState("")
  const [result, setResult] = useState<ImportResult | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const types = useQuery({
    queryKey: ["io-types"],
    queryFn: () =>
      api<{ object_types: IOTypeMeta[] }>("/api/io/types/").then(
        (r) => r.object_types
      ),
    staleTime: 5 * 60_000,
  })
  const typeOptions = useMemo<SelectOption[]>(
    () =>
      (types.data ?? [])
        .filter((t) => t.can_import)
        .map((t) => ({ value: t.slug, label: `${t.label} (${t.group})` })),
    [types.data]
  )

  const fields = useQuery({
    queryKey: ["io-fields", objectType],
    queryFn: () => ioFields(objectType!),
    enabled: !!objectType,
    staleTime: 5 * 60_000,
  })

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      ioImport(objectType!, { format, content, dry_run: dryRun }),
    onSuccess: (r) => setResult(r),
    onError: () => setResult(null),
  })

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (!f) return
    if (f.name.endsWith(".json")) setFormat("json")
    else if (f.name.endsWith(".csv")) setFormat("csv")
    const reader = new FileReader()
    reader.onload = () => setContent(String(reader.result ?? ""))
    reader.readAsText(f)
  }

  if (isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>

  const ready = !!objectType && content.trim().length > 0
  const err = run.error as Error | null

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="grid max-w-3xl gap-4">
        <p className="text-xs text-muted-foreground">
          Bulk import from CSV or JSON — rows are matched by <code>id</code> or
          natural key, so existing rows <b>update</b> and new ones are created.
          Links resolve by human-readable name within the current tenant.
          Validate first to preview, then import. Tip: export from any table to
          get a ready-to-edit file.
        </p>

        <div className="grid grid-cols-[1fr_auto] gap-3">
          <FormSelect
            label="Object type"
            value={objectType}
            onChange={(v) => {
              setObjectType(v)
              setResult(null)
            }}
            options={typeOptions}
            placeholder="Pick a type"
          />
          <FormSelect
            label="Format"
            value={format}
            onChange={(v) => setFormat((v as Format) ?? "csv")}
            options={[
              { value: "csv", label: "CSV" },
              { value: "json", label: "JSON" },
            ]}
          />
        </div>

        {objectType && fields.data && (
          <Field label="Available columns" hint="empty = match all / optional">
            <div className="flex flex-wrap gap-1">
              {fields.data.fields.map((f) => (
                <Badge
                  key={f.name}
                  variant={f.required ? "default" : "secondary"}
                  className="font-mono text-[10px]"
                  title={`${f.kind}${f.required ? " · required" : ""}`}
                >
                  {f.name}
                  {f.required && "*"}
                </Badge>
              ))}
            </div>
          </Field>
        )}

        <Field
          label="Data"
          hint={
            format === "csv"
              ? "First row = column headers"
              : "A JSON array of objects"
          }
        >
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value)
              setResult(null)
            }}
            rows={12}
            spellCheck={false}
            className="w-full rounded-md border border-input bg-transparent p-3 font-mono text-[12px] leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring"
            placeholder={
              format === "csv"
                ? "name,slug,description\nAcme,acme,A provider"
                : '[\n  { "name": "Acme", "slug": "acme" }\n]'
            }
          />
        </Field>

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.json,text/csv,application/json"
            className="hidden"
            onChange={onFile}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="size-4" /> Upload file
          </Button>
          <div className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => run.mutate(true)}
              disabled={!ready || run.isPending}
            >
              {run.isPending && run.variables === true && (
                <Spinner className="size-4" />
              )}
              Validate
            </Button>
            <Button
              onClick={() => run.mutate(false)}
              disabled={!ready || run.isPending}
            >
              {run.isPending && run.variables === false && (
                <Spinner className="size-4" />
              )}
              Import
            </Button>
          </div>
        </div>

        {err && <p className="text-[13px] text-destructive">{err.message}</p>}

        {result && (
          <div className="rounded-lg border border-border">
            <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
              <CheckCircle2
                className={
                  "size-4 " +
                  (result.errors.length ? "text-amber-500" : "text-emerald-500")
                }
              />
              <span className="text-sm font-medium">
                {result.dry_run ? "Preview" : "Imported"}: {result.created}{" "}
                created · {result.updated ?? 0} updated
                <span className="text-muted-foreground">
                  {" "}
                  of {result.total} rows
                </span>
              </span>
              {result.errors.length > 0 && (
                <Badge variant="destructive" className="text-[10px]">
                  {result.errors.length} error
                  {result.errors.length > 1 ? "s" : ""}
                </Badge>
              )}
            </div>
            {result.errors.length > 0 && (
              <div className="max-h-72 overflow-auto p-2">
                <DataTable
                  columns={errorColumns}
                  data={result.errors}
                  flexColumn="error"
                  enableExport={false}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
