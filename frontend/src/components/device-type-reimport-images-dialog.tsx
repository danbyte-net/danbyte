import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { FormCheckbox } from "@/components/forms"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"

/** Danbyte's fork of the devicetype-library — same layout, images under
 * elevation-images/. Any owner/name, github.com URL, or https base works. */
const DEFAULT_REPO = "https://github.com/danbyte-net/device-library"

type FaceState =
  | "kept"
  | "available"
  | "downloaded"
  | "not_found"
  | "fetch_failed"

interface ReimportRow {
  id: string
  name: string
  manufacturer: string
  slug: string
  status: "matched" | "no_match" | "skipped_has_images" | "fetch_failed"
  faces: Partial<Record<"front" | "rear", FaceState>>
  downloaded: number
}

/** Counts keyed by status; a key the server hasn't reached yet is absent. */
type Totals = Partial<Record<string, number>>

interface ReimportReport {
  dry_run: boolean
  overwrite: boolean
  repo: string
  results: ReimportRow[]
  totals: Totals
}

interface ReimportRun {
  id: string
  kind: string
  status: "queued" | "running" | "success" | "failed"
  progress: Totals
  failures: { name: string; error: string }[]
  options: { overwrite?: boolean; dry_run?: boolean }
  error: string
}

const STATUS_LABEL: Record<ReimportRow["status"], string> = {
  matched: "Matched",
  no_match: "No match",
  skipped_has_images: "Has images",
  fetch_failed: "Fetch failed",
}

const FACE_LABEL: Record<FaceState, string> = {
  kept: "kept",
  available: "in repo",
  downloaded: "downloaded",
  not_found: "not in repo",
  fetch_failed: "fetch failed",
}

function faceCell(state?: FaceState) {
  if (!state) return <span className="text-muted-foreground">—</span>
  const cls =
    state === "fetch_failed"
      ? "text-red-600 dark:text-red-400"
      : state === "downloaded" || state === "available"
        ? "text-foreground"
        : "text-muted-foreground"
  return <span className={cls}>{FACE_LABEL[state]}</span>
}

const COLUMNS: SimpleColumn<ReimportRow>[] = [
  {
    id: "name",
    header: "Device type",
    flex: true,
    cell: (r) => (
      <span className="font-medium">
        {r.name}
        {r.slug && (
          <span className="ml-2 font-mono text-[11px] font-normal text-muted-foreground">
            {r.slug}
          </span>
        )}
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (r) => (
      <span
        className={
          r.status === "fetch_failed"
            ? "text-red-600 dark:text-red-400"
            : r.status === "no_match"
              ? "text-muted-foreground"
              : undefined
        }
      >
        {STATUS_LABEL[r.status]}
      </span>
    ),
  },
  { id: "front", header: "Front", cell: (r) => faceCell(r.faces.front) },
  { id: "rear", header: "Rear", cell: (r) => faceCell(r.faces.rear) },
]

function totalsLine(t: Totals, applied: boolean): string {
  const parts = [
    `${t.matched ?? 0} matched`,
    `${t.no_match ?? 0} no match`,
    `${t.skipped_has_images ?? 0} already have images`,
  ]
  if (t.fetch_failed) parts.push(`${t.fetch_failed} fetch failed`)
  if (applied) parts.push(`${t.images_downloaded ?? 0} images downloaded`)
  return parts.join(" · ")
}

/**
 * Recovery tool: the media folder was lost or corrupted but the device types
 * survived in the database. Point Danbyte at a devicetype-library-layout
 * repository and it matches the EXISTING types and re-downloads their
 * elevation images — nothing else is created or changed. Fill-gaps by
 * default: a face counts as a gap when the field is empty or its file is
 * missing from storage.
 */
export function DeviceTypeReimportImagesDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [repo, setRepo] = useState(DEFAULT_REPO)
  const [overwrite, setOverwrite] = useState(false)
  const [report, setReport] = useState<ReimportReport | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const bgDone = useRef(false)

  const reset = () => {
    setReport(null)
    setRunId(null)
    bgDone.current = false
  }

  // Over the sync cap the server answers 202 with a background run instead —
  // poll it exactly like the folder import does.
  const runQ = useQuery({
    queryKey: ["dt-reimport-run", runId],
    queryFn: () => api<ReimportRun>(`/api/device-types/import-runs/${runId}/`),
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === "success" || s === "failed" ? false : 1500
    },
  })
  const bg = runQ.data
  if (
    bg &&
    !bgDone.current &&
    (bg.status === "success" || bg.status === "failed")
  ) {
    bgDone.current = true
    if (bg.status === "success") {
      const p = bg.progress
      if (bg.options.dry_run) {
        toast.success(`Dry run complete — ${totalsLine(p, false)}`)
      } else {
        qc.invalidateQueries({ queryKey: ["device-types"] })
        toast.success(
          `Reimported ${p.images_downloaded ?? 0} image${p.images_downloaded === 1 ? "" : "s"} across ${p.matched ?? 0} device type${p.matched === 1 ? "" : "s"}`
        )
      }
    } else {
      toast.error(bg.error || "Image reimport failed.")
    }
  }

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api<ReimportReport | { run: ReimportRun }>(
        `/api/device-types/reimport-images/?${new URLSearchParams({
          ...(dryRun ? { dry_run: "1" } : {}),
          ...(overwrite ? { overwrite: "1" } : {}),
        }).toString()}`,
        { method: "POST", body: JSON.stringify({ repo }) }
      ),
    onSuccess: (data) => {
      if ("run" in data) {
        // Big catalog — the server queued a background run.
        setReport(null)
        bgDone.current = false
        setRunId(data.run.id)
        return
      }
      setRunId(null)
      setReport(data)
      if (!data.dry_run) {
        const n = data.totals.images_downloaded ?? 0
        if (n > 0) {
          qc.invalidateQueries({ queryKey: ["device-types"] })
          toast.success(`Downloaded ${n} image${n === 1 ? "" : "s"}`)
        } else {
          toast.info("No images were downloaded — see the report below.")
        }
      }
    },
    // An airgapped deployment answers 409 with the offline recovery route;
    // the toast carries that message to the operator.
    onError: (err) => apiErrorToast(err),
  })

  const bgActive =
    !!runId && bg?.status !== "success" && bg?.status !== "failed"
  const busy = run.isPending || bgActive

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle>Reimport images</DialogTitle>
          <DialogDescription>
            Re-download front/rear elevation images for your{" "}
            <span className="font-medium">existing</span> device types from a
            devicetype-library-style repository — the recovery path when the
            media folder was lost or corrupted. Types are matched by
            manufacturer and model; nothing is created or renamed.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <label
              htmlFor="reimport-repo"
              className="text-[12px] font-medium text-foreground"
            >
              Repository
            </label>
            <Input
              id="reimport-repo"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder={DEFAULT_REPO}
              className="font-mono text-[12px]"
            />
            <p className="text-[11px] text-muted-foreground">
              <span className="font-mono">owner/name</span>, a github.com URL,
              or an https base. Images are expected in the library layout:{" "}
              <span className="font-mono">
                elevation-images/&lt;Manufacturer&gt;/&lt;slug&gt;.front|rear.png
              </span>
            </p>
          </div>

          <FormCheckbox
            className="text-[12px] text-muted-foreground"
            label={
              <>
                Overwrite existing images too. Off, only gaps are filled — a
                face whose field is empty <em>or</em> whose file is missing from
                the media folder (the corrupt-media case).
              </>
            }
            checked={overwrite}
            onChange={setOverwrite}
          />

          {runId && bg && (
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-medium">
                  {bg.status === "success"
                    ? bg.options.dry_run
                      ? "Dry run complete"
                      : "Reimport complete"
                    : bg.status === "failed"
                      ? "Reimport failed"
                      : "Matching catalog…"}
                </span>
                <span className="num text-muted-foreground">
                  {bg.progress.done ?? 0}/{bg.progress.total ?? "…"}
                </span>
              </div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{
                    width: bg.progress.total
                      ? `${Math.round(((bg.progress.done ?? 0) / bg.progress.total) * 100)}%`
                      : "8%",
                  }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-muted-foreground">
                {totalsLine(bg.progress, !bg.options.dry_run)}
              </p>
              {bg.status === "failed" && bg.error && (
                <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
                  {bg.error}
                </p>
              )}
              {bg.failures.length > 0 && (
                <ul className="mt-2 max-h-32 space-y-0.5 overflow-auto text-[11px] text-muted-foreground">
                  {bg.failures.slice(0, 20).map((f, i) => (
                    <li key={i} className="truncate">
                      <span className="font-mono">{f.name}</span> — {f.error}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {report && (
            <div className="grid gap-2">
              <p className="text-[12px] text-muted-foreground">
                {report.dry_run ? "Dry run — nothing written. " : ""}
                {totalsLine(report.totals, !report.dry_run)}
              </p>
              <div className="max-h-64 overflow-auto">
                <SimpleTable
                  columns={COLUMNS}
                  data={report.results}
                  getRowKey={(r) => r.id}
                  empty="No device types in scope."
                />
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              variant="outline"
              onClick={() => run.mutate(true)}
              disabled={busy || !repo.trim()}
            >
              {run.isPending && run.variables === true
                ? "Checking…"
                : "Dry run"}
            </Button>
            <Button
              onClick={() => run.mutate(false)}
              disabled={busy || !repo.trim()}
            >
              {run.isPending && run.variables === false
                ? "Reimporting…"
                : "Reimport images"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
