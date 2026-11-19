import { useEffect, useRef, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Upload } from "lucide-react"
import { toast } from "sonner"

import { api, formatBytes } from "@/lib/api"
import type { ModelPackDetail, ModelPackLimits } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox } from "@/components/forms/checkbox"
import { FormText } from "@/components/forms/text"
import { Loading } from "@/components/loading"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { packLabel } from "@/components/columns/model-pack-columns"
import {
  BundleReport,
  InstallOutcomes,
  ModelPackReport,
  NeedsLine,
} from "@/components/model-pack-report"

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
  const { done, total, pack, index, count: packs } = p.progress
  const count = total ? ` ${done ?? 0} of ${total}` : ""
  const which = pack
    ? ` · ${pack}${index && packs ? ` (${index} of ${packs})` : ""}`
    : ""
  if (phase === "downloading") return `Downloading${which}…`
  if (phase === "dry run") return `Dry run${count}${which}…`
  if (p.status === "installing") return `Installing${count}${which}…`
  return "Checking…"
}

const toggle = (list: string[], id: string, on: boolean) =>
  on ? [...new Set([...list, id])] : list.filter((x) => x !== id)

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
  const [overwrite, setOverwrite] = useState(false)
  const [packId, setPackId] = useState<string | null>(null)
  // A bundle's picked packs (null: every pack it can install) and the
  // missing required packs to fetch from the pack catalog first.
  const [picked, setPicked] = useState<string[] | null>(null)
  const [withPacks, setWithPacks] = useState<string[]>([])
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
    setOverwrite(false)
    setPackId(null)
    setPicked(null)
    setWithPacks([])
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

  const isBundle = p?.kind === "bundle"
  const sections = p?.report.packs ?? []
  const pickedIds =
    picked ?? sections.filter((s) => s.installable).map((s) => s.id)
  const canInstall = isBundle
    ? sections.some((s) => s.installable && pickedIds.includes(s.id))
    : !!p?.installable

  const install = useMutation({
    mutationFn: () =>
      api<ModelPackDetail>(`/api/model-packs/${packId}/install/`, {
        method: "POST",
        body: JSON.stringify({
          replace_photos: replace,
          overwrite,
          with: withPacks,
          ...(isBundle ? { packs: pickedIds } : {}),
        }),
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
    const outcomes = p.result.packs
    toast.success(
      outcomes
        ? `Installed ${outcomes.filter((o) => o.status === "installed").length} of ${outcomes.length} packs`
        : `Installed ${packLabel(p)} ${p.version}`
    )
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
        {p && !busy && done && (
          <InstallOutcomes
            outcomes={[...(p.result.requires ?? []), ...(p.result.packs ?? [])]}
            onOpen={() => onOpenChange(false)}
          />
        )}
        {p && !busy && isBundle && (
          <BundleReport
            pack={p}
            picked={p.status === "checked" ? pickedIds : undefined}
            onPick={
              p.status === "checked"
                ? (id, on) => setPicked(toggle(pickedIds, id, on))
                : undefined
            }
            withPacks={withPacks}
            onWith={
              p.status === "checked"
                ? (id, on) => setWithPacks(toggle(withPacks, id, on))
                : undefined
            }
          />
        )}
        {p && !busy && !isBundle && <ModelPackReport pack={p} />}
        {p && !busy && !isBundle && (
          <NeedsLine
            needs={p.report.needs ?? []}
            withPacks={withPacks}
            onWith={
              p.status === "checked"
                ? (id, on) => setWithPacks(toggle(withPacks, id, on))
                : undefined
            }
          />
        )}
        {p?.status === "checked" && canInstall && (
          <div className="space-y-2">
            <FormCheckbox
              label="Replace hand-uploaded photos"
              checked={replace}
              onChange={setReplace}
            />
            <FormCheckbox
              label="Update from pack"
              checked={overwrite}
              onChange={setOverwrite}
              info="The pack replaces what the dry run kept. Documents added or edited here stay."
            />
          </div>
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
              disabled={!canInstall || busy || install.isPending}
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
