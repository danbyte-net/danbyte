import { useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { CheckCircle2, XCircle } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { apiErrorToast } from "@/lib/api-toast"

interface ImportResult {
  ok: boolean
  name: string
  id: string | null
  created: Record<string, number>
  skipped: string[]
  error: string | null
}

interface ImportRun {
  id: string
  status: "queued" | "running" | "success" | "failed"
  progress: { done?: number; total?: number; created?: number; failed?: number }
  failures: { name: string; error: string }[]
  error: string
}

/** A lone github.com /tree/ folder URL — routed to the background importer. */
const FOLDER_RE =
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/tree\/[^/]+(\/.*)?$/
const folderUrlOf = (items: string[]): string | null =>
  items.length === 1 && FOLDER_RE.test(items[0].trim())
    ? items[0].trim()
    : null

/**
 * Import device types from NetBox's community devicetype-library
 * (github.com/netbox-community/devicetype-library — public domain). Accepts
 * pasted YAML, pasted GitHub URLs (one per line; blob links auto-convert to
 * raw), or uploaded .yaml files. The optional stack tick rewrites the leading
 * slot digit to Danbyte's `{position}` token — the library targets NetBox,
 * which has no stack-position concept.
 */
export function DeviceTypeImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState("")
  const [files, setFiles] = useState<{ name: string; content: string }[]>([])
  const [stack, setStack] = useState(false)
  const [results, setResults] = useState<ImportResult[] | null>(null)
  const [runId, setRunId] = useState<string | null>(null)
  const bgDone = useRef(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const reset = () => {
    setText("")
    setFiles([])
    setResults(null)
    setRunId(null)
    bgDone.current = false
    if (fileRef.current) fileRef.current.value = ""
  }

  // Background run polling — for a whole-folder import that's too big to fetch
  // synchronously. Stops when the run reaches a terminal state.
  const runQ = useQuery({
    queryKey: ["dt-import-run", runId],
    queryFn: () =>
      api<ImportRun>(`/api/device-types/import-runs/${runId}/`),
    enabled: !!runId,
    refetchInterval: (q) => {
      const s = q.state.data?.status
      return s === "success" || s === "failed" ? false : 1500
    },
  })
  const bg = runQ.data
  if (bg && !bgDone.current && (bg.status === "success" || bg.status === "failed")) {
    bgDone.current = true
    if (bg.status === "success") {
      qc.invalidateQueries({ queryKey: ["device-types"] })
      qc.invalidateQueries({ queryKey: ["device-types-picker"] })
      qc.invalidateQueries({ queryKey: ["manufacturers"] })
      const p = bg.progress
      toast.success(
        `Imported ${p.created ?? 0} device type${p.created === 1 ? "" : "s"}` +
          (p.failed ? ` · ${p.failed} failed` : "")
      )
    } else {
      toast.error(bg.error || "Import failed.")
    }
  }

  const startBg = useMutation({
    mutationFn: (url: string) =>
      api<ImportRun>("/api/device-types/import-folder/", {
        method: "POST",
        body: JSON.stringify({ url, stack_positions: stack }),
      }),
    onSuccess: (run) => {
      bgDone.current = false
      setRunId(run.id)
    },
    onError: (err) => apiErrorToast(err),
  })

  const buildItems = (): string[] => {
    const items = files.map((f) => f.content)
    const t = text.trim()
    if (t) {
      const lines = t
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
      // A block of URLs = one item per line; anything else = one YAML doc.
      if (lines.every((l) => l.startsWith("http"))) items.push(...lines)
      else items.push(t)
    }
    return items
  }

  const run = useMutation({
    mutationFn: () =>
      api<{ results: ImportResult[] }>("/api/device-types/import-yaml/", {
        method: "POST",
        body: JSON.stringify({ items: buildItems(), stack_positions: stack }),
      }),
    onSuccess: (data) => {
      setResults(data.results)
      const ok = data.results.filter((r) => r.ok).length
      if (ok) {
        qc.invalidateQueries({ queryKey: ["device-types"] })
        qc.invalidateQueries({ queryKey: ["device-types-picker"] })
        qc.invalidateQueries({ queryKey: ["manufacturers"] })
        toast.success(
          `Imported ${ok} device type${ok === 1 ? "" : "s"}` +
            (ok < data.results.length
              ? ` · ${data.results.length - ok} failed`
              : "")
        )
      } else {
        toast.error("Nothing imported — see the report below.")
      }
    },
    onError: (err) => apiErrorToast(err),
  })

  const onFiles = async (list: FileList | null) => {
    if (!list) return
    const read = await Promise.all(
      Array.from(list).map(async (f) => ({
        name: f.name,
        content: await f.text(),
      }))
    )
    setFiles(read)
  }

  const items = buildItems()
  const folderUrl = folderUrlOf(items)
  const bgActive =
    !!runId && bg?.status !== "success" && bg?.status !== "failed"
  const canRun =
    items.length > 0 && !run.isPending && !startBg.isPending && !bgActive

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) reset()
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import device types</DialogTitle>
          <DialogDescription>
            Paste YAML from the{" "}
            <a
              href="https://github.com/netbox-community/devicetype-library"
              target="_blank"
              rel="noreferrer"
              className="text-primary hover:underline"
            >
              NetBox devicetype-library
            </a>{" "}
            (or GitHub links, one per line), or upload the .yaml files. A link
            to a <span className="font-medium">folder</span> (a{" "}
            <span className="font-mono">/tree/</span> URL, e.g. one
            manufacturer) imports every device type in it. Manufacturers are
            created as needed.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={
              "https://github.com/netbox-community/devicetype-library/tree/master/device-types/Cisco\n— a single file, or the YAML itself —"
            }
            className="min-h-28 font-mono text-[12px]"
          />
          <div className="flex flex-wrap items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept=".yaml,.yml"
              multiple
              onChange={(e) => void onFiles(e.target.files)}
              className="text-[12px] file:mr-2 file:rounded-md file:border file:border-border file:bg-transparent file:px-2 file:py-1 file:text-[12px] file:text-foreground"
            />
            {files.length > 0 && (
              <span className="num text-[11px] text-muted-foreground">
                {files.length} file{files.length === 1 ? "" : "s"} loaded
              </span>
            )}
          </div>
          <label className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <input
              type="checkbox"
              className="ck"
              checked={stack}
              onChange={(e) => setStack(e.target.checked)}
            />
            Stackable — rewrite the leading slot digit to{" "}
            <code className="font-mono">{"{position}"}</code>
          </label>

          {runId && bg && (
            <div className="rounded-md border border-border p-3">
              <div className="flex items-center justify-between text-[12px]">
                <span className="font-medium">
                  {bg.status === "success"
                    ? "Import complete"
                    : bg.status === "failed"
                      ? "Import failed"
                      : "Importing folder…"}
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
              <div className="mt-1.5 flex gap-3 text-[11px] text-muted-foreground">
                <span className="text-emerald-600 dark:text-emerald-400">
                  {bg.progress.created ?? 0} created
                </span>
                {(bg.progress.failed ?? 0) > 0 && (
                  <span className="text-red-600 dark:text-red-400">
                    {bg.progress.failed} failed
                  </span>
                )}
              </div>
              {bg.status === "failed" && bg.error && (
                <p className="mt-1.5 text-[11px] text-red-600 dark:text-red-400">
                  {bg.error}
                </p>
              )}
              {bg.failures?.length > 0 && (
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

          {results && (
            <div className="max-h-56 space-y-2 overflow-auto rounded-md border border-border p-2">
              {results.map((r, i) => (
                <div key={i} className="flex items-start gap-2 text-[12px]">
                  {r.ok ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                  )}
                  <div className="min-w-0">
                    <span
                      className={cn(
                        "font-mono",
                        !r.ok && "text-muted-foreground"
                      )}
                    >
                      {r.name || "(unnamed)"}
                    </span>
                    {r.ok ? (
                      <span className="text-muted-foreground">
                        {" — "}
                        {Object.entries(r.created)
                          .filter(([, n]) => n > 0)
                          .map(([k, n]) => `${n} ${k.replaceAll("_", " ")}`)
                          .join(", ") || "no components"}
                      </span>
                    ) : (
                      <span className="text-red-600 dark:text-red-400">
                        {" — "}
                        {r.error}
                      </span>
                    )}
                    {r.skipped.length > 0 && (
                      <ul className="mt-0.5 list-inside list-disc text-[11px] text-muted-foreground">
                        {r.skipped.map((s, j) => (
                          <li key={j}>{s}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              onClick={() =>
                folderUrl ? startBg.mutate(folderUrl) : run.mutate()
              }
              disabled={!canRun}
            >
              {run.isPending || startBg.isPending || bgActive
                ? "Importing…"
                : folderUrl
                  ? "Import folder"
                  : "Import"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
