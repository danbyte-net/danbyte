import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type CheckKind,
  type CheckTemplate,
  type Paginated,
} from "@/lib/api"
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
  const [kind, setKind] = useState<CheckKind>("icmp")
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
              interval_seconds: Number(interval),
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
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add check on {target.label}</DialogTitle>
        </DialogHeader>

        {/* Existing vs new toggle */}
        <div className="flex items-center gap-1 rounded-md bg-muted p-0.5 text-[13px]">
          {(
            [
              ["existing", "Use existing"],
              ["new", "New check"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              disabled={key === "existing" && !hasTemplates}
              onClick={() => setMode(key)}
              className={`flex-1 rounded px-3 py-1.5 font-medium transition-colors disabled:opacity-40 ${
                mode === key
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

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
                    const k = (v as CheckKind) ?? "icmp"
                    setKind(k)
                    setVals(initialValues(k))
                  }}
                  options={KINDS}
                />
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
                placeholder={`${kind.toUpperCase()} check`}
              />
              <CheckFields kind={kind} vals={vals} onChange={set} />
              <p className="text-[11px] text-muted-foreground">
                This is saved as a reusable template you can attach elsewhere
                and edit later.
              </p>
            </>
          )}

          <div className="mt-2 flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={m.isPending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit || m.isPending}>
              {m.isPending ? "Adding…" : "Add check"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
