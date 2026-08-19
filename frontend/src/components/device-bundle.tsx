import { useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Download, Upload } from "lucide-react"

import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCheckbox } from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"

/**
 * Device-type **bundles** - one file carrying everything that makes a hardware
 * model work in Danbyte: component templates, the faceplate layout, the
 * photo-port markers, inventory templates, and the vendor SNMP sensors that read
 * its health. Export what you built; someone else imports it and gets your
 * result instead of redoing the work.
 *
 * Bundles carry **no credentials** - sensors poll with the importing
 * deployment's own SNMP profile.
 */

interface ImportReport {
  dry_run: boolean
  device_type: string
  action: "create" | "update" | "skipped"
  components: Record<string, number>
  sensors: { created: number; updated: number; skipped: number }
  faceplate: boolean
  image_ports: boolean
  missing_images: string[]
  warnings: string[]
}

/** Download this device type's bundle as a file. */
export function ExportBundleButton({
  deviceTypeId,
  name,
}: {
  deviceTypeId: string
  name: string
}) {
  const [busy, setBusy] = useState(false)
  const run = async () => {
    setBusy(true)
    try {
      const bundle = await api<Record<string, unknown>>(
        `/api/device-types/${deviceTypeId}/library-export/`
      )
      const blob = new Blob([JSON.stringify(bundle, null, 2)], {
        type: "application/json",
      })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      // A filename someone can recognise a year later in a downloads folder.
      a.download = `${name.replace(/[^\w.-]+/g, "-").toLowerCase()}.danbyte.json`
      a.click()
      URL.revokeObjectURL(url)
      toast.success("Bundle downloaded")
    } catch (e) {
      apiErrorToast(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Button variant="outline" size="sm" onClick={run} disabled={busy}>
      <Download className="h-3.5 w-3.5" />
      {busy ? "Exporting…" : "Export bundle"}
    </Button>
  )
}

/**
 * Import a bundle. Always previews first: importing a file from elsewhere should
 * never be a blind action, so the dialog runs a dry run, shows exactly what it
 * would create, and only then offers to apply it.
 */
export function ImportBundleDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [text, setText] = useState("")
  const [replace, setReplace] = useState(false)
  const [preview, setPreview] = useState<ImportReport | null>(null)
  const [done, setDone] = useState<ImportReport | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const post = (dryRun: boolean) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error("That isn't valid JSON.")
    }
    const params = new URLSearchParams()
    if (dryRun) params.set("dry_run", "1")
    if (replace) params.set("replace", "1")
    return api<ImportReport>(
      `/api/device-types/import-bundle/?${params.toString()}`,
      { method: "POST", body: JSON.stringify(parsed) }
    )
  }

  const check = useMutation({
    mutationFn: () => post(true),
    onSuccess: setPreview,
    onError: (e) => apiErrorToast(e),
  })
  const apply = useMutation({
    mutationFn: () => post(false),
    onSuccess: (r) => {
      setDone(r)
      qc.invalidateQueries({ queryKey: ["device-types"] })
      qc.invalidateQueries({ queryKey: ["snmp-sensors"] })
      toast.success(
        r.action === "skipped"
          ? "Nothing imported - the type already exists"
          : `${r.device_type} ${r.action === "update" ? "updated" : "imported"}`
      )
    },
    onError: (e) => apiErrorToast(e),
  })

  const reset = () => {
    setText("")
    setReplace(false)
    setPreview(null)
    setDone(null)
  }
  const report = done ?? preview

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent size="xl">
        <DialogHeader>
          <DialogTitle>Import a device bundle</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          A bundle carries a hardware model's component templates, faceplate,
          photo-port markers and SNMP health sensors. Imported sensors are
          observe-only: they surface differences as drift and never write a
          status you set.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (!f) return
            setPreview(null)
            setDone(null)
            void f.text().then(setText)
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            size="sm"
            variant="outline"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" /> Choose file…
          </Button>
          <FormCheckbox
            label="Update the device type if it already exists"
            checked={replace}
            onChange={setReplace}
          />
        </div>
        <Textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setPreview(null)
            setDone(null)
          }}
          rows={8}
          spellCheck={false}
          placeholder='{"danbyte_device_type": 1, "name": "…", "components": { … }}'
          className="font-mono text-[11px]"
        />

        {report && (
          <div className="grid gap-1 rounded-md border border-border bg-muted/30 p-2 text-[11px]">
            <span className="font-medium">
              {report.device_type} ·{" "}
              {report.action === "skipped"
                ? "already exists - nothing to do"
                : report.action === "update"
                  ? done
                    ? "updated"
                    : "would be updated"
                  : done
                    ? "imported"
                    : "would be created"}
            </span>
            {Object.entries(report.components).length > 0 && (
              <span className="text-muted-foreground">
                {Object.entries(report.components)
                  .map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`)
                  .join(" · ")}
              </span>
            )}
            <span className="text-muted-foreground">
              {report.faceplate ? "faceplate" : "no faceplate"} ·{" "}
              {report.image_ports ? "photo ports" : "no photo ports"} ·{" "}
              {report.sensors.created + report.sensors.updated} sensor
              {report.sensors.created + report.sensors.updated === 1 ? "" : "s"}
            </span>
            {report.warnings.map((w, i) => (
              <span key={i} className="text-amber-600 dark:text-amber-400">
                {w}
              </span>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {!done && (
            <>
              <Button
                variant="outline"
                onClick={() => check.mutate()}
                disabled={!text.trim() || check.isPending}
              >
                {check.isPending ? "Checking…" : "Preview"}
              </Button>
              <Button
                onClick={() => apply.mutate()}
                disabled={!preview || apply.isPending}
                title={!preview ? "Preview it first" : undefined}
              >
                {apply.isPending ? "Importing…" : "Import"}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
