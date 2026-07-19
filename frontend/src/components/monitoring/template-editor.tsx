import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type CheckKind, type CheckTemplate } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { FormSelect, FormText } from "@/components/forms"
import {
  CheckFields,
  INTERVALS,
  KINDS,
  buildParams,
  initialValues,
  missingRequired,
  valuesFromTemplate,
  type Vals,
} from "./check-fields"
import { apiErrorToast } from "@/lib/api-toast"

// Create or edit a reusable CheckTemplate. Editing propagates to every
// assignment using it (the resolver reads template params live).
export function TemplateEditor({
  template,
  open,
  onOpenChange,
}: {
  template?: CheckTemplate
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const isEdit = !!template

  const [name, setName] = useState("")
  const [kind, setKind] = useState<CheckKind>("icmp")
  const [interval, setInterval] = useState("300")
  const [vals, setVals] = useState<Vals>(() => initialValues("icmp"))

  // Re-seed when the dialog opens for a different template (or for "new").
  useEffect(() => {
    if (!open) return
    if (template) {
      setName(template.name)
      setKind(template.kind)
      setInterval(String(template.interval_seconds))
      setVals(valuesFromTemplate(template))
    } else {
      setName("")
      setKind("icmp")
      setInterval("300")
      setVals(initialValues("icmp"))
    }
  }, [open, template])

  const canSubmit = name.trim().length > 0 && !missingRequired(kind, vals)

  const save = useMutation({
    mutationFn: async () => {
      const { params, secret_params } = buildParams(kind, vals)
      const body: Record<string, unknown> = {
        name: name.trim(),
        kind,
        params,
        interval_seconds: Number(interval),
        degraded_enabled: true,
      }
      // Only send secrets when the user actually entered some — otherwise a
      // PATCH would wipe stored credentials with blanks.
      if (Object.keys(secret_params).length > 0)
        body.secret_params = secret_params

      if (isEdit) {
        await api(`/api/monitoring/templates/${template!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(body),
        })
      } else {
        await api("/api/monitoring/templates/", {
          method: "POST",
          body: JSON.stringify(body),
        })
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["check-templates"] })
      qc.invalidateQueries({ queryKey: ["ip-checks"] })
      qc.invalidateQueries({ queryKey: ["prefix-checks"] })
      toast.success(isEdit ? `Saved ${name.trim()}` : `Created ${name.trim()}`)
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  const set = (k: string, v: string | boolean) =>
    setVals((prev) => ({ ...prev, [k]: v }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit check · ${template!.name}` : "New check template"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) save.mutate()
          }}
          className="grid gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            {isEdit ? (
              <div className="space-y-1">
                <label className="text-[11px] tracking-wide text-muted-foreground uppercase">
                  Type
                </label>
                <div className="flex h-9 items-center rounded-md border border-border bg-muted/40 px-3 text-sm text-muted-foreground">
                  {KINDS.find((k) => k.value === kind)?.label ?? kind}
                </div>
              </div>
            ) : (
              <FormSelect
                label="Type"
                value={kind}
                onChange={(v) => {
                  const k = (v as CheckKind) ?? "icmp"
                  setKind(k)
                  setVals(initialValues(k))
                }}
                options={KINDS}
              />
            )}
            <FormSelect
              label="Interval"
              value={interval}
              onChange={(v) => setInterval(v ?? "300")}
              options={INTERVALS}
            />
          </div>

          <FormText
            label="Name"
            required
            autoFocus
            value={name}
            onChange={setName}
            placeholder="e.g. HTTP health :8080"
          />

          <CheckFields kind={kind} vals={vals} onChange={set} />

          {isEdit && (template.usage_count ?? 0) > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Used by {template.usage_count} assignment
              {template.usage_count === 1 ? "" : "s"} — saving updates them all.
            </p>
          )}

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={save.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || save.isPending}>
              {save.isPending ? "Saving…" : isEdit ? "Save" : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
