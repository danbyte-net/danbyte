import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type CheckTemplate, type Paginated } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormFooter, FormSelect, FormText } from "@/components/forms"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  CheckFields,
  checkIntervals,
  intervalBody,
  useCheckKinds,
  buildParams,
  initialValues,
  missingRequired,
  specsFor,
  type Vals,
} from "./check-fields"
import { apiErrorToast } from "@/lib/api-toast"

export interface CheckTarget {
  kind: "ip" | "prefix"
  id: string
  label: string
}

export function AddCheckDialog({
  target,
  open,
  onOpenChange,
}: {
  target: CheckTarget
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const qc = useQueryClient()
  const [mode, setMode] = useState<"existing" | "new">("existing")

  // New-check fields
  const [kind, setKind] = useState<string>("icmp")
  const kinds = useCheckKinds()
  const kindLabel = kinds.find((k) => k.value === kind)?.label ?? kind
  const [name, setName] = useState("")
  const [interval, setInterval] = useState("300")
  const [vals, setVals] = useState<Vals>(() => initialValues("icmp"))
  // Existing-template pick
  const [templateId, setTemplateId] = useState<string | null>(null)

  const templates = useQuery({
    queryKey: ["check-templates"],
    queryFn: () => api<Paginated<CheckTemplate>>("/api/monitoring/templates/"),
    enabled: open,
  })
  const hasTemplates = (templates.data?.results.length ?? 0) > 0

  useEffect(() => {
    if (!open) return
    setMode(hasTemplates ? "existing" : "new")
    setName("")
    setKind("icmp")
    setInterval("300")
    setVals(initialValues("icmp"))
    setTemplateId(templates.data?.results[0]?.id ?? null)
  }, [open, hasTemplates, templates.data])

  const canSubmit =
    mode === "existing"
      ? !!templateId
      : name.trim().length > 0 && !missingRequired(kind, vals)

  const m = useMutation({
    mutationFn: async () => {
      let tid = templateId
      if (mode === "new") {
        const { params, secret_params } = buildParams(kind, vals)
        const template = await api<CheckTemplate>(
          "/api/monitoring/templates/",
          {
            method: "POST",
            body: JSON.stringify({
              name: name.trim(),
              kind,
              params,
              secret_params,
              ...intervalBody(interval),
              degraded_enabled: true,
            }),
          }
        )
        tid = template.id
      }
      await api("/api/monitoring/assignments/", {
        method: "POST",
        body: JSON.stringify({
          template: tid,
          ...(target.kind === "ip"
            ? { ip_address: target.id }
            : { prefix: target.id, apply_to_children: true }),
          schedule_mode: "custom_on",
        }),
      })
    },
    onSuccess: () => {
      qc.invalidateQueries({
        queryKey: [
          target.kind === "ip" ? "ip-checks" : "prefix-checks",
          target.id,
        ],
      })
      qc.invalidateQueries({ queryKey: ["check-templates"] })
      toast.success(`Added a check on ${target.label}`)
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
          <DialogTitle>Add check on {target.label}</DialogTitle>
        </DialogHeader>

        {/* A kind with no templates yet has nothing to pick from; the tab is
            simply absent rather than disabled, and the effect above already
            forces "new" in that case. */}
        <SegmentedTabs
          value={mode}
          onValueChange={setMode}
          items={[
            ...(hasTemplates
              ? [{ value: "existing" as const, label: "Use existing" }]
              : []),
            { value: "new" as const, label: "New check" },
          ]}
        />

        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) m.mutate()
          }}
          className="grid gap-4"
        >
          {mode === "existing" ? (
            <FormSelect
              label="Check template"
              value={templateId}
              onChange={setTemplateId}
              placeholder="Pick a check"
              options={(templates.data?.results ?? []).map((t) => ({
                value: t.id,
                label: `${t.name} · ${t.kind}`,
              }))}
            />
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
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
                <FormSelect
                  label="Interval"
                  info="Under a minute runs on the fast lane: status changes recorded at once, the rest as one aggregated result a minute."
                  value={interval}
                  onChange={(v) => setInterval(v ?? "300")}
                  options={checkIntervals(kind)}
                />
              </div>
              <FormText
                label="Name"
                required
                autoFocus
                value={name}
                onChange={setName}
                placeholder={`${kind.toUpperCase()} check`}
              />
              <CheckFields kind={kind} vals={vals} onChange={set} />
              {specsFor(kind).length === 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Nothing to configure here - a {kindLabel} check is answered by
                  the engine bound to the target.
                </p>
              )}
              <p className="text-[11px] text-muted-foreground">
                Saved as a template; attach it elsewhere or edit it later.
              </p>
            </>
          )}

          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={m.isPending}
            submitLabel="Add check"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
