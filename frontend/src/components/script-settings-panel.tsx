import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Script, ScriptParam, ScriptParamType } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SettingsCard } from "@/components/settings/settings-card"
import { Field } from "@/components/forms/field"
import { FormCheckbox } from "@/components/forms/checkbox"
import { FormRow } from "@/components/forms/row"
import { FormSelect } from "@/components/forms/select"
import { FormText } from "@/components/forms/text"

const PARAM_TYPES: { value: ScriptParamType; label: string }[] = [
  { value: "string", label: "Text" },
  { value: "text", label: "Long text" },
  { value: "integer", label: "Whole number" },
  { value: "decimal", label: "Number" },
  { value: "boolean", label: "Yes / no" },
  { value: "choice", label: "One of a list" },
]

/** How the script runs, and the parameters its Run dialog asks for. */
export function ScriptSettingsPanel({
  script,
  canEdit,
}: {
  script: Script
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const [scope, setScope] = useState(script.token_scope)
  const [timeout, setTimeoutValue] = useState(String(script.timeout_seconds))
  const [runAs, setRunAs] = useState(script.run_as)
  const [enabled, setEnabled] = useState(script.enabled)
  const [params, setParams] = useState<ScriptParam[]>(script.params_schema)

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ["script", script.id] })
    void qc.invalidateQueries({ queryKey: ["scripts"] })
  }
  const save = useMutation({
    mutationFn: () =>
      api<Script>(`/api/scripts/${script.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          token_scope: scope,
          timeout_seconds: Number(timeout) || 300,
          run_as: runAs,
          enabled,
          params_schema: params,
        }),
      }),
    onSuccess: () => {
      toast.success("Saved")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })
  const trust = useMutation({
    mutationFn: (trusted: boolean) =>
      api<Script>(`/api/scripts/${script.id}/trust/`, {
        method: "POST",
        body: JSON.stringify({ trusted }),
      }),
    onSuccess: invalidate,
    onError: (e) => apiErrorToast(e),
  })

  const setParam = (i: number, patch: Partial<ScriptParam>) =>
    setParams(params.map((p, j) => (j === i ? { ...p, ...patch } : p)))

  return (
    <SettingsCard
      title="How it runs"
      description="Access, limits, and the parameters the Run dialog asks for."
      onSave={canEdit ? () => save.mutate() : undefined}
      saving={save.isPending}
      dirty
    >
      <FormRow cols={3}>
        <FormSelect
          label="API access"
          info="A read-only run cannot create, change or delete anything, whatever the script's code says."
          value={scope}
          onChange={(v) => setScope((v ?? "full") as Script["token_scope"])}
          options={[
            { value: "full", label: "Read and write" },
            { value: "read", label: "Read only" },
          ]}
          disabled={!canEdit}
        />
        <FormText
          label="Timeout"
          hint="seconds"
          type="number"
          min={5}
          max={3600}
          value={timeout}
          onChange={setTimeoutValue}
          disabled={!canEdit}
        />
        <FormSelect
          label="Runs as"
          info="Whose access the script gets. Choose the owner so a shared script always sees the same data."
          value={runAs}
          onChange={(v) => setRunAs((v ?? "caller") as Script["run_as"])}
          options={[
            { value: "caller", label: "The person who runs it" },
            {
              value: "owner",
              label: `The owner (${script.owner_name ?? "-"})`,
            },
          ]}
          disabled={!canEdit}
        />
      </FormRow>
      <FormCheckbox
        label="Enabled"
        checked={enabled}
        onChange={setEnabled}
        disabled={!canEdit}
      />

      {canDo("script", "trust") && (
        <Field
          label="Trusted"
          info="A trusted script reaches the database directly instead of going through the API. It runs with the worker's own privileges."
        >
          <div className="flex items-center gap-2">
            <Badge variant={script.trusted ? "warning" : "secondary"}>
              {script.trusted ? "Trusted" : "Sandboxed"}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              onClick={() => trust.mutate(!script.trusted)}
              disabled={trust.isPending}
            >
              {script.trusted ? "Make sandboxed" : "Mark trusted"}
            </Button>
          </div>
        </Field>
      )}

      <Field label="Parameters">
        <div className="space-y-2">
          {params.length === 0 && (
            <p className="text-xs text-muted-foreground">
              None. The script runs with no input.
            </p>
          )}
          {params.map((p, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_9rem_auto_auto] items-end gap-2"
            >
              <FormText
                label="Name"
                value={p.name}
                onChange={(v) => setParam(i, { name: v })}
                disabled={!canEdit}
                mono
              />
              <FormSelect
                label="Type"
                value={p.type}
                onChange={(v) =>
                  setParam(i, { type: (v ?? "string") as ScriptParamType })
                }
                options={PARAM_TYPES}
                disabled={!canEdit}
              />
              <FormCheckbox
                label="Required"
                checked={p.required}
                onChange={(v) => setParam(i, { required: v })}
                disabled={!canEdit}
              />
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Remove parameter"
                  onClick={() => setParams(params.filter((_, j) => j !== i))}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
          {params.some((p) => p.type === "choice") && (
            <p className="text-xs text-muted-foreground">
              Options for a list are comma-separated below each name.
            </p>
          )}
          {params.map((p, i) =>
            p.type === "choice" ? (
              <FormText
                key={`choices-${i}`}
                label={`Options for ${p.name}`}
                value={p.choices.join(", ")}
                onChange={(v) =>
                  setParam(i, {
                    choices: v
                      .split(",")
                      .map((c) => c.trim())
                      .filter(Boolean),
                  })
                }
                disabled={!canEdit}
              />
            ) : null
          )}
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setParams([
                  ...params,
                  {
                    name: `param_${params.length + 1}`,
                    label: "",
                    type: "string",
                    required: false,
                    default: null,
                    choices: [],
                    help: "",
                    object_type: "",
                  },
                ])
              }
            >
              <Plus className="size-3.5" /> Add parameter
            </Button>
          )}
        </div>
      </Field>
    </SettingsCard>
  )
}
