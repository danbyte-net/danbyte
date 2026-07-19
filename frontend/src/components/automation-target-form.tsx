import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type AutomationKind,
  type AutomationTarget,
  type AutomationTargetWritePayload,
} from "@/lib/api"
import {
  FormCheckbox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface AutomationTargetFormProps {
  target?: AutomationTarget
  onSaved: (v: AutomationTarget) => void
  onCancel: () => void
}

export function AutomationTargetForm({
  target,
  onSaved,
  onCancel,
}: AutomationTargetFormProps) {
  const isEdit = !!target
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(target?.name ?? "")
  const [kind, setKind] = useState<AutomationKind>(target?.kind ?? "awx")
  const [enabled, setEnabled] = useState(target?.enabled ?? true)
  const [baseUrl, setBaseUrl] = useState(target?.base_url ?? "")
  const [jobTemplateId, setJobTemplateId] = useState(
    target?.job_template_id ?? ""
  )
  const [token, setToken] = useState("")
  const [sslVerify, setSslVerify] = useState(target?.ssl_verify ?? true)
  const [autoOnChange, setAutoOnChange] = useState(
    target?.auto_on_change ?? false
  )
  const [extraVars, setExtraVars] = useState(
    target?.extra_vars && Object.keys(target.extra_vars).length
      ? JSON.stringify(target.extra_vars, null, 2)
      : ""
  )
  const [jsonError, setJsonError] = useState<string | null>(null)

  useEffect(() => {
    if (!target) return
    setName(target.name)
    setKind(target.kind)
    setEnabled(target.enabled)
    setBaseUrl(target.base_url)
    setJobTemplateId(target.job_template_id)
    setToken("")
    setSslVerify(target.ssl_verify)
    setAutoOnChange(target.auto_on_change)
    setExtraVars(
      Object.keys(target.extra_vars ?? {}).length
        ? JSON.stringify(target.extra_vars, null, 2)
        : ""
    )
    reset()
  }, [target, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      let extra: Record<string, unknown> = {}
      if (extraVars.trim()) {
        try {
          extra = JSON.parse(extraVars)
        } catch {
          setJsonError("Invalid JSON.")
          throw new Error("Invalid extra_vars JSON.")
        }
      }
      setJsonError(null)
      const payload: AutomationTargetWritePayload = {
        name: name.trim(),
        kind,
        enabled,
        base_url: baseUrl.trim(),
        job_template_id: kind === "awx" ? jobTemplateId.trim() : "",
        ssl_verify: sslVerify,
        auto_on_change: autoOnChange,
        extra_vars: extra,
        object_types: ["device"],
      }
      if (token.trim()) payload.token = token
      if (isEdit)
        return api<AutomationTarget>(`/api/automation-targets/${target!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<AutomationTarget>("/api/automation-targets/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["automation-targets"] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      if ((err as Error).message === "Invalid extra_vars JSON.") return
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid max-w-2xl gap-4"
    >
      <div className="grid grid-cols-[1fr_auto_auto] items-end gap-4">
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
        <FormSelect
          label="Kind"
          value={kind}
          onChange={(v) => setKind((v as AutomationKind) ?? "awx")}
          options={[
            { value: "awx", label: "Ansible AWX / AAP" },
            { value: "webhook", label: "Generic webhook" },
          ]}
        />
        <FormCheckbox
          label="Enabled"
          checked={enabled}
          onChange={setEnabled}
          className="pb-2"
        />
      </div>

      <FormText
        label={kind === "awx" ? "AWX controller URL" : "Webhook URL"}
        required
        type="url"
        mono
        placeholder={
          kind === "awx"
            ? "https://awx.example.com"
            : "https://ci.example.com/hook"
        }
        value={baseUrl}
        onChange={setBaseUrl}
        error={fieldErrors.base_url}
      />

      {kind === "awx" && (
        <FormText
          label="Job template ID"
          required
          mono
          placeholder="42"
          value={jobTemplateId}
          onChange={setJobTemplateId}
          error={fieldErrors.job_template_id}
        />
      )}

      <FormText
        label={kind === "awx" ? "Bearer token" : "Signing secret"}
        type="password"
        autoComplete="new-password"
        placeholder={target?.token_set ? "Saved — leave blank to keep" : ""}
        hint={
          kind === "awx"
            ? "AWX/AAP OAuth token (sent as Authorization: Bearer)"
            : "HMAC-SHA512 signs the payload in X-Danbyte-Signature"
        }
        value={token}
        onChange={setToken}
        error={fieldErrors.token}
      />

      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <FormCheckbox
          label="Verify TLS certificate"
          checked={sslVerify}
          onChange={setSslVerify}
        />
        <FormCheckbox
          label="Auto-deploy on change"
          checked={autoOnChange}
          onChange={setAutoOnChange}
          hint="Fire automatically when a device changes"
        />
      </div>

      <FormTextarea
        label="Extra vars (JSON)"
        hint="Merged into the AWX launch / webhook payload"
        rows={4}
        value={extraVars}
        onChange={(v) => {
          setExtraVars(v)
          setJsonError(null)
        }}
        error={jsonError ?? fieldErrors.extra_vars}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create target"}
      />
    </form>
  )
}
