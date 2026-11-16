import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { toast } from "sonner"

import { api, formatBytes } from "@/lib/api"
import type { ModelPackDetail, ModelPackLimits } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import { FormCheckbox } from "@/components/forms/checkbox"
import { FormText } from "@/components/forms/text"
import { Loading } from "@/components/loading"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  buildModelPackFindingColumns,
  buildModelPackTypeColumns,
  packLabel,
} from "@/components/columns/model-pack-columns"

type Source = "upload" | "url"

const ACTIVE = new Set(["checking", "installing"])

/** The pack being checked or installed, polled while a job works on it. */
export function useModelPack(id: string | null | undefined) {
  return useQuery({
    queryKey: ["model-packs", id],
    queryFn: () => api<ModelPackDetail>(`/api/model-packs/${id}/`),
    enabled: !!id,
    refetchInterval: (q) =>
      q.state.data && ACTIVE.has(q.state.data.status) ? 1500 : false,
  })
}

function progressText(p: ModelPackDetail): string {
  const phase = p.progress.phase ?? ""
  const { done, total } = p.progress
  const count = total ? ` ${done ?? 0} of ${total}` : ""
  if (phase === "downloading") return "Downloading…"
  if (phase === "dry run") return `Dry run${count}…`
  if (p.status === "installing") return `Installing${count}…`
  return "Checking…"
}

/** The check's outcome: what the install would do, and what the checker
 * found. Shared with the pack's page. */
export function ModelPackReport({ pack }: { pack: ModelPackDetail }) {
  const check = pack.report.check
  const dry = pack.report.import
  const typeColumns = useMemo(() => buildModelPackTypeColumns(), [])
  const findingColumns = useMemo(() => buildModelPackFindingColumns(), [])
  if (pack.report.refusals?.length)
    return (
      <ul className="space-y-0.5 text-sm text-destructive">
        {pack.report.refusals.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    )
  if (!check || !dry) return null
  const installed = pack.report.installed
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {packLabel(pack)} {pack.version}
        </span>
        {pack.license && <Badge variant="secondary">{pack.license}</Badge>}
        <Badge variant="secondary">{dry.created} to create</Badge>
        <Badge variant="secondary">{dry.matched} to update</Badge>
        {check.errors > 0 && (
          <Badge variant="destructive">
            {check.errors} error{check.errors === 1 ? "" : "s"}
          </Badge>
        )}
        {check.warnings > 0 && (
          <Badge variant="warning">
            {check.warnings} warning{check.warnings === 1 ? "" : "s"}
          </Badge>
        )}
        {installed && (
          <span className="text-xs text-muted-foreground">
            Installed: {installed.version}
          </span>
        )}
      </div>
      <DataTable
        data={dry.types}
        columns={typeColumns}
        tableId="model-pack-types"
        flexColumn="notes"
        autoColumns={false}
      />
      {check.findings.length > 0 && (
        <DataTable
          data={check.findings}
          columns={findingColumns}
          tableId="model-pack-findings"
          flexColumn="message"
          autoColumns={false}
        />
      )}
    </div>
  )
}

/**
 * Install a 3D model pack: upload a .zip or give a URL, read the check and
 * dry run, then install. Nothing changes until Install.
 */
export function ModelPackInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [source, setSource] = useState<Source>("upload")
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState("")
  const [replace, setReplace] = useState(false)
  const [packId, setPackId] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const limits = useQuery({
    queryKey: ["model-packs", "limits"],
    queryFn: () => api<ModelPackLimits>("/api/model-packs/limits/"),
    enabled: open,
  })
  const pack = useModelPack(packId)
  const p = pack.data

  const reset = () => {
    setFile(null)
    setUrl("")
    setReplace(false)
    setPackId(null)
    setSource("upload")
  }

  const add = useMutation({
    mutationFn: () => {
      if (source === "upload") {
        const body = new FormData()
        if (file) body.append("file", file)
        return api<ModelPackDetail>("/api/model-packs/", {
          method: "POST",
          body,
        })
      }
      return api<ModelPackDetail>("/api/model-packs/", {
        method: "POST",
        body: JSON.stringify({ url: url.trim() }),
      })
    },
    onSuccess: (row) => {
      setPackId(row.id)
      qc.setQueryData(["model-packs", row.id], row)
    },
    onError: (e) => apiErrorToast(e),
  })

  const install = useMutation({
    mutationFn: () =>
      api<ModelPackDetail>(`/api/model-packs/${packId}/install/`, {
        method: "POST",
        body: JSON.stringify({ replace_photos: replace }),
      }),
    onSuccess: (row) => qc.setQueryData(["model-packs", row.id], row),
    onError: (e) => apiErrorToast(e),
  })

  const max = limits.data?.max_bytes ?? 0
  const tooBig = !!file && max > 0 && file.size > max
  const canAdd =
    !p &&
    (source === "upload"
      ? !!file && !tooBig
      : url.trim().startsWith("https://"))
  const busy = !!p && ACTIVE.has(p.status)
  const done = p?.status === "installed"

  // Toast once when the install lands; refresh the list behind the dialog.
  const announced = useRef<string | null>(null)
  useEffect(() => {
    if (!p || !done || announced.current === p.id) return
    announced.current = p.id
    toast.success(`Installed ${packLabel(p)} ${p.version}`)
    void qc.invalidateQueries({ queryKey: ["model-packs"] })
  }, [done, p, qc])

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          if (p) void qc.invalidateQueries({ queryKey: ["model-packs"] })
          reset()
        }
        onOpenChange(o)
      }}
    >
      <DialogContent size="5xl">
        <DialogHeader>
          <DialogTitle>Install pack</DialogTitle>
        </DialogHeader>

        {!p && (
          <div className="space-y-3">
            <SegmentedTabs
              items={[
                { value: "upload", label: "Upload" },
                ...(limits.data?.downloads === false
                  ? []
                  : [{ value: "url" as const, label: "URL" }]),
              ]}
              value={source}
              onValueChange={setSource}
              label="Pack source"
            />
            {source === "upload" ? (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileRef}
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => fileRef.current?.click()}
                >
                  <Upload className="h-3.5 w-3.5" /> Choose .zip
                </Button>
                <span className="text-sm text-muted-foreground">
                  {file
                    ? `${file.name} · ${formatBytes(file.size)}`
                    : max
                      ? `Up to ${formatBytes(max)}`
                      : ""}
                </span>
                {tooBig && (
                  <span className="text-sm text-destructive">Too large</span>
                )}
              </div>
            ) : (
              <FormText
                label="URL"
                value={url}
                onChange={setUrl}
                type="url"
                mono
                placeholder={limits.data?.source_url || "https://"}
                info={
                  limits.data
                    ? [limits.data.source_url, ...limits.data.allowed_hosts]
                        .filter(Boolean)
                        .join(", ") || "No download source is configured."
                    : undefined
                }
              />
            )}
          </div>
        )}

        {p && busy && <Loading className="min-h-32" />}
        {p && busy && (
          <p className="text-center text-xs text-muted-foreground">
            {progressText(p)}
          </p>
        )}
        {p && !busy && p.error && (
          <p className="text-sm text-destructive">{p.error}</p>
        )}
        {p && !busy && <ModelPackReport pack={p} />}
        {p?.status === "checked" && p.installable && (
          <FormCheckbox
            label="Replace hand-uploaded photos"
            checked={replace}
            onChange={setReplace}
          />
        )}

        <DialogFooter>
          {p && done ? (
            <Button size="sm" variant="outline" asChild>
              <Link
                to="/settings/device-library/packs/$id"
                params={{ id: p.id }}
                onClick={() => onOpenChange(false)}
              >
                Open pack
              </Link>
            </Button>
          ) : null}
          {!p && (
            <Button
              size="sm"
              disabled={!canAdd || add.isPending}
              onClick={() => add.mutate()}
            >
              {add.isPending ? "Checking…" : "Check"}
            </Button>
          )}
          {p && !done && (
            <Button
              size="sm"
              disabled={!p.installable || busy || install.isPending}
              onClick={() => install.mutate()}
            >
              {p.status === "installing" || install.isPending
                ? "Installing…"
                : "Install"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
