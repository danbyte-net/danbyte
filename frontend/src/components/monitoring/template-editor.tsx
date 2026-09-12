import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type CheckTemplate } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FormFooter, FormSelect, FormText } from "@/components/forms"
import {
  CheckFields,
  RECORD_EVERY,
  checkIntervals,
  intervalBody,
  intervalValue,
  isFastInterval,
  useCheckKinds,
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
  const [kind, setKind] = useState<string>("icmp")
  const kinds = useCheckKinds()
  const [interval, setInterval] = useState("300")
  const [recordEvery, setRecordEvery] = useState("60")
  const [vals, setVals] = useState<Vals>(() => initialValues("icmp"))

  // Re-seed when the dialog opens for a different template (or for "new").
  useEffect(() => {
    if (!open) return
    if (template) {
      setName(template.name)
      setKind(template.kind)
      setInterval(intervalValue(template))
      setRecordEvery(String(template.record_every_seconds ?? 60))
      setVals(valuesFromTemplate(template))
    } else {
      setName("")
      setKind("icmp")
      setInterval("300")
      setRecordEvery("60")
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
        ...intervalBody(interval, template?.interval_seconds),
        record_every_seconds: Number(recordEvery),
        degraded_enabled: true,
      }
      // Only send secrets when the user actually entered some - otherwise a
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
      <DialogContent size="xl" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit check · ${template!.name}` : "New check"}
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
              <Field label="Type" hint="fixed once created">
                <div className="flex h-9 items-center text-sm text-muted-foreground">
                  {kinds.find((k) => k.value === kind)?.label ?? kind}
                </div>
              </Field>
            ) : (
              <FormSelect
                label="Type"
                value={kind}
                onChange={(v) => {
                  const k = v ?? "icmp"
                  setKind(k)
                  setVals(initialValues(k))
                }}
                options={kinds}
              />
            )}
            <FormSelect
              label="Interval"
              info="Under a minute runs on the fast lane: a status change is recorded the moment it happens, everything else once per recording window. If the lane is down, or an older Outpost holds the check, it runs every minute instead."
              value={interval}
              onChange={(v) => setInterval(v ?? "300")}
              options={checkIntervals(kind)}
            />
          </div>
          {isFastInterval(interval) && (
            <div className="max-w-xs">
              <FormSelect
                label="Record every"
                info="How often one aggregated result (min, average, max latency and loss) is stored. Fewer rows, same history: status changes are always stored at once."
                value={recordEvery}
                onChange={(v) => setRecordEvery(v ?? "60")}
                options={RECORD_EVERY}
              />
            </div>
          )}

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
              {template.usage_count === 1 ? "" : "s"} - saving updates them all.
            </p>
          )}

          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Create"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
