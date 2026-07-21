import { createFileRoute } from "@tanstack/react-router"
import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { CheckCircle2, AlertTriangle, Server, Play } from "lucide-react"

import {
  api,
  type NetBoxImportRun,
  type NetBoxTestResult,
  type NetBoxTypeTotals,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Checkbox } from "@/components/ui/checkbox"
import { DataTable } from "@/components/data-table"
import { Field } from "@/components/forms"
import { StateBadge } from "@/routes/jobs.index"

export const Route = createFileRoute("/import/netbox")({
  component: NetBoxImportPage,
})

type TypeRow = { key: string } & NetBoxTypeTotals

const TYPE_COLUMNS: ColumnDef<TypeRow, unknown>[] = [
  {
    id: "key",
    accessorKey: "key",
    header: "Type",
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.key}</span>
    ),
  },
  {
    id: "fetched",
    accessorKey: "fetched",
    header: "Fetched",
    cell: ({ row }) => <Num n={row.original.fetched} />,
  },
  {
    id: "created",
    accessorKey: "created",
    header: "New",
    cell: ({ row }) => <Num n={row.original.created} tone="emerald" />,
  },
  {
    id: "existed",
    accessorKey: "existed",
    header: "Existing",
    cell: ({ row }) => <Num n={row.original.existed} muted />,
  },
  {
    id: "updated",
    accessorKey: "updated",
    header: "Updated",
    cell: ({ row }) => <Num n={row.original.updated} tone="sky" />,
  },
  {
    id: "failed",
    accessorKey: "failed",
    header: "Failed",
    cell: ({ row }) => <Num n={row.original.failed} tone="red" />,
  },
  {
    id: "skipped",
    accessorKey: "skipped",
    header: "Skipped",
    cell: ({ row }) => <Num n={row.original.skipped ?? 0} tone="amber" />,
  },
]

function Num({
  n,
  tone,
  muted,
}: {
  n: number
  tone?: string
  muted?: boolean
}) {
  const cls =
    n === 0
      ? "text-muted-foreground/50"
      : muted
        ? "text-muted-foreground"
        : tone === "emerald"
          ? "text-emerald-600 dark:text-emerald-400"
          : tone === "red"
            ? "text-red-600 dark:text-red-400"
            : tone === "amber"
              ? "text-amber-600 dark:text-amber-400"
              : tone === "sky"
                ? "text-sky-600 dark:text-sky-400"
                : ""
  return <span className={`num tabular-nums ${cls}`}>{n}</span>
}

const failureColumns: ColumnDef<string, unknown>[] = [
  {
    id: "failure",
    accessorFn: (r) => r,
    header: "Failure",
    cell: ({ row }) => (
      <span className="text-red-700 dark:text-red-300">
        {row.original as unknown as string}
      </span>
    ),
  },
]

function NetBoxImportPage() {
  const { canManage, isLoading } = useMe()
  const qc = useQueryClient()

  // ── connect ──
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [insecure, setInsecure] = useState(false)
  const [test, setTest] = useState<NetBoxTestResult | null>(null)

  // ── options ──
  const [dryRun, setDryRun] = useState(true)
  const [updateExisting, setUpdateExisting] = useState(false)

  // ── active run (polled) ──
  const [runId, setRunId] = useState<string | null>(null)

  const testMut = useMutation({
    mutationFn: () =>
      api<NetBoxTestResult>("/api/netbox-import/test/", {
        method: "POST",
        body: JSON.stringify({
          url: url.trim(),
          token: token.trim(),
          insecure,
        }),
      }),
    onSuccess: (r) => setTest(r),
    onError: (e: Error) => setTest({ ok: false, error: e.message }),
  })

  const launch = useMutation({
    mutationFn: () =>
      api<NetBoxImportRun>("/api/netbox-import/", {
        method: "POST",
        body: JSON.stringify({
          url: url.trim(),
          token: token.trim(),
          insecure,
          dry_run: dryRun,
          update_existing: updateExisting,
        }),
      }),
    onSuccess: (r) => {
      setRunId(r.id)
      qc.invalidateQueries({ queryKey: ["netbox-imports"] })
    },
  })

  // Poll the active run until it finishes.
  const run = useQuery({
    queryKey: ["netbox-import", runId],
    queryFn: () => api<NetBoxImportRun>(`/api/netbox-import/${runId}/`),
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === "success" || s === "failed" ? false : 2500
    },
  })

  const history = useQuery({
    queryKey: ["netbox-imports"],
    queryFn: () => api<NetBoxImportRun[]>("/api/netbox-import/"),
    enabled: canManage,
    refetchInterval: runId ? 5000 : false,
  })

  if (isLoading)
    return <p className="p-6 text-sm text-muted-foreground">Loading…</p>
  if (!canManage)
    return (
      <p className="p-6 text-sm text-muted-foreground">
        Tenant admin required to import from NetBox.
      </p>
    )

  const ready = url.trim().length > 0 && token.trim().length > 0
  const active = run.data
  const running =
    active && (active.status === "queued" || active.status === "running")

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="grid max-w-3xl gap-5">
        <p className="text-xs text-muted-foreground">
          Migrate an existing NetBox instance into <b>this tenant</b> over its
          REST API. Test the connection to see what will be pulled, run a dry
          run to preview, then import for real. Re-running is safe — existing
          objects are skipped unless you opt into updating them.
        </p>

        {/* ── Connect ── */}
        <section className="grid gap-3 rounded-lg border border-border p-4">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Server className="size-4" /> Connect
          </h2>
          <Field label="NetBox URL">
            <Input
              value={url}
              onChange={(e) => {
                setUrl(e.target.value)
                setTest(null)
              }}
              placeholder="https://netbox.example.com"
              className="font-mono text-[13px]"
            />
          </Field>
          <Field
            label="API token"
            hint="a read-only token is enough — never stored after the run"
          >
            <Input
              type="password"
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                setTest(null)
              }}
              placeholder="0123456789abcdef…"
              className="font-mono text-[13px]"
            />
          </Field>
          <label className="flex items-center gap-2 text-[13px]">
            <Checkbox
              checked={insecure}
              onCheckedChange={(v) => setInsecure(!!v)}
            />
            Allow self-signed certificate
          </label>
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              onClick={() => testMut.mutate()}
              disabled={!ready || testMut.isPending}
            >
              {testMut.isPending && <Spinner className="size-4" />}
              Test connection
            </Button>
            {test &&
              (test.ok ? (
                <span className="flex items-center gap-1.5 text-[13px] text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-4" />
                  NetBox {test.netbox_version ?? "connected"}
                </span>
              ) : (
                <span className="flex items-center gap-1.5 text-[13px] text-destructive">
                  <AlertTriangle className="size-4" />
                  {test.error}
                </span>
              ))}
          </div>
          {test?.ok && test.counts && (
            <div className="flex flex-wrap gap-1.5 pt-1">
              {Object.entries(test.counts).map(([k, v]) => (
                <Badge
                  key={k}
                  variant="secondary"
                  className="font-mono text-[10px]"
                >
                  {k}: {v.toLocaleString()}
                </Badge>
              ))}
            </div>
          )}
        </section>

        {/* ── Options + launch ── */}
        <section className="grid gap-3 rounded-lg border border-border p-4">
          <h2 className="text-sm font-semibold">Options</h2>
          <label className="flex items-start gap-2 text-[13px]">
            <Checkbox
              className="mt-0.5"
              checked={dryRun}
              onCheckedChange={(v) => setDryRun(!!v)}
            />
            <span>
              Dry run
              <span className="block text-[11px] text-muted-foreground">
                Fetch and build everything, then roll back — real counts,
                nothing saved. Recommended first.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2 text-[13px]">
            <Checkbox
              className="mt-0.5"
              checked={updateExisting}
              onCheckedChange={(v) => setUpdateExisting(!!v)}
            />
            <span>
              Update existing objects
              <span className="block text-[11px] text-muted-foreground">
                Re-apply NetBox values to objects already in Danbyte.{" "}
                <b>Overwrites local edits.</b> Off = existing rows are left
                untouched.
              </span>
            </span>
          </label>
          <div>
            <Button
              onClick={() => launch.mutate()}
              disabled={!ready || launch.isPending || !!running}
            >
              {launch.isPending && <Spinner className="size-4" />}
              <Play className="size-4" />
              {dryRun ? "Start dry run" : "Import for real"}
            </Button>
            {launch.error && (
              <p className="mt-2 text-[13px] text-destructive">
                {(launch.error as Error).message}
              </p>
            )}
          </div>
        </section>

        {/* ── Progress / result ── */}
        {active && (
          <RunPanel
            run={active}
            onRunReal={() => {
              setDryRun(false)
              setRunId(null)
            }}
          />
        )}

        {/* ── History ── */}
        {history.data && history.data.length > 0 && (
          <section className="grid gap-2">
            <h2 className="text-sm font-semibold">Recent imports</h2>
            <div className="divide-y divide-border rounded-lg border border-border">
              {history.data.map((h) => (
                <button
                  key={h.id}
                  onClick={() => setRunId(h.id)}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-[13px] hover:bg-muted/50"
                >
                  <StateBadge state={statusToState(h.status)} />
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {h.url}
                  </span>
                  {h.dry_run && (
                    <Badge variant="secondary" className="text-[10px]">
                      dry run
                    </Badge>
                  )}
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">
                    {new Date(h.created_at).toLocaleString()}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

function RunPanel({
  run,
  onRunReal,
}: {
  run: NetBoxImportRun
  onRunReal: () => void
}) {
  const running = run.status === "queued" || run.status === "running"
  const pct = run.progress?.pct ?? (run.status === "success" ? 100 : 0)
  const totals = run.report?.totals ?? run.progress?.totals
  const byType = run.report?.by_type ?? run.progress?.by_type ?? {}
  const failures = run.report?.failures ?? []
  const notes = run.report?.notes ?? []

  const rows = useMemo<TypeRow[]>(
    () =>
      Object.entries(byType)
        .map(([key, t]) => ({ key, ...t }))
        .filter((r) => r.fetched > 0 || r.failed > 0 || (r.skipped ?? 0) > 0)
        .sort((a, b) => a.key.localeCompare(b.key)),
    [byType]
  )

  return (
    <section className="grid gap-3 rounded-lg border border-border p-4">
      {/* progress bar (mirrors the upgrade card on /jobs) */}
      <div>
        <div className="flex items-center gap-2 text-[13px]">
          {running ? (
            <>
              <Spinner className="size-4" />
              <span className="font-medium">
                {run.status === "queued" ? "Queued…" : "Importing"}
              </span>
              {run.progress?.key && (
                <span className="text-muted-foreground">
                  · {run.progress.key} ({run.progress.step}/{run.progress.total}
                  )
                </span>
              )}
              {run.progress?.fetching && (
                <span className="text-muted-foreground tabular-nums">
                  · fetching {run.progress.fetching.rows.toLocaleString()} row
                  {run.progress.fetching.rows === 1 ? "" : "s"}…
                </span>
              )}
            </>
          ) : run.status === "success" ? (
            <>
              <CheckCircle2 className="size-4 text-emerald-500" />
              <span className="font-medium">
                {run.dry_run ? "Dry run complete" : "Import complete"}
              </span>
              {run.dry_run && (
                <span className="text-muted-foreground">
                  — nothing was saved
                </span>
              )}
            </>
          ) : (
            <>
              <AlertTriangle className="size-4 text-destructive" />
              <span className="font-medium">Import failed</span>
            </>
          )}
          <span className="ml-auto text-muted-foreground tabular-nums">
            {pct}%
          </span>
        </div>
        <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className={
              "h-full transition-all " +
              (run.status === "failed" ? "bg-destructive" : "bg-primary")
            }
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {run.status === "failed" && run.error && (
        <p className="text-[13px] text-destructive">{run.error}</p>
      )}

      {/* totals */}
      {totals && (
        <div className="flex flex-wrap gap-3 text-[13px]">
          <span>
            <b className="num">{totals.fetched}</b> fetched
          </span>
          <span className="text-emerald-600 dark:text-emerald-400">
            <b className="num">{totals.created}</b> new
          </span>
          <span className="text-muted-foreground">
            <b className="num">{totals.existed}</b> existing
          </span>
          {totals.updated > 0 && (
            <span className="text-sky-600 dark:text-sky-400">
              <b className="num">{totals.updated}</b> updated
            </span>
          )}
          {totals.failed > 0 && (
            <span className="text-red-600 dark:text-red-400">
              <b className="num">{totals.failed}</b> failed
            </span>
          )}
          {(totals.skipped ?? 0) > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              <b className="num">{totals.skipped}</b> skipped
            </span>
          )}
        </div>
      )}

      {/* per-type table, fills in as steps complete */}
      {rows.length > 0 && (
        <div className="max-h-80 overflow-auto rounded-md border border-border">
          <DataTable columns={TYPE_COLUMNS} data={rows} enableExport={false} />
        </div>
      )}

      {notes.length > 0 && (
        // Open by default when short — the notes explain skips and fetch
        // failures, and collapsed-by-default hid exactly that diagnosis.
        <details
          className="text-[12px] text-muted-foreground"
          open={notes.length <= 10}
        >
          <ul className="mt-1 list-disc pl-5">
            {notes.slice(0, 50).map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      {failures.length > 0 && (
        <div>
          <p className="mb-1 text-[13px] font-medium text-destructive">
            {failures.length} failure(s)
          </p>
          <div className="max-h-60 overflow-auto rounded-md border border-border">
            <DataTable
              columns={failureColumns}
              data={failures}
              flexColumn="failure"
              enableExport={false}
            />
          </div>
        </div>
      )}

      {/* offer a real run after a clean dry run */}
      {run.status === "success" && run.dry_run && (
        <div>
          <Button onClick={onRunReal}>
            <Play className="size-4" /> Looks good — run for real
          </Button>
        </div>
      )}
    </section>
  )
}

function statusToState(s: NetBoxImportRun["status"]): string {
  return s === "success"
    ? "finished"
    : s === "failed"
      ? "failed"
      : s === "running"
        ? "started"
        : "queued"
}
