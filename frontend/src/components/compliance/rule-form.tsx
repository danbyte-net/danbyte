import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ComplianceCheck,
  type ComplianceRule,
  type ComplianceSeverity,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FormSelect } from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"

const OBJECT_TYPES = [
  { value: "prefix", label: "Prefix" },
  { value: "ipaddress", label: "IP address" },
  { value: "device", label: "Device" },
  { value: "vlan", label: "VLAN" },
  { value: "vrf", label: "VRF" },
  { value: "site", label: "Site" },
]
const CHECKS: { value: ComplianceCheck; label: string }[] = [
  { value: "required", label: "Field must be set" },
  { value: "forbidden", label: "Field must be empty" },
  { value: "regex", label: "Field must match a pattern" },
  { value: "required_tag", label: "Must carry a tag" },
  { value: "required_cf", label: "Custom field must be set" },
]
const SEVERITIES: { value: ComplianceSeverity; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
]

export function ComplianceRuleForm({
  rule,
  onSaved,
  onCancel,
}: {
  rule?: ComplianceRule
  onSaved: () => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const isEdit = !!rule
  const [name, setName] = useState(rule?.name ?? "")
  const [description, setDescription] = useState(rule?.description ?? "")
  const [remediation, setRemediation] = useState(rule?.remediation ?? "")
  const [objectType, setObjectType] = useState(rule?.object_type ?? "prefix")
  const [check, setCheck] = useState<ComplianceCheck>(
    rule?.check_type ?? "required"
  )
  const [severity, setSeverity] = useState<ComplianceSeverity>(
    rule?.severity ?? "warning"
  )
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [field, setField] = useState(rule?.field ?? "")
  const [pattern, setPattern] = useState(rule?.pattern ?? "")
  const [tag, setTag] = useState(rule?.tag ?? "")
  const [cfKey, setCfKey] = useState(rule?.cf_key ?? "")

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: name.trim(),
        description,
        remediation,
        object_type: objectType,
        check_type: check,
        severity,
        enabled,
        field,
        pattern,
        tag,
        cf_key: cfKey,
      }
      return isEdit
        ? api(`/api/compliance-rules/${rule!.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/compliance-rules/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["compliance-rules"] })
      qc.invalidateQueries({ queryKey: ["compliance-eval"] })
      toast.success(isEdit ? `Saved ${name.trim()}` : `Created ${name.trim()}`)
      onSaved()
    },
    onError: (err) => apiErrorToast(err),
  })

  const usesField = ["required", "forbidden", "regex"].includes(check)

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) save.mutate()
      }}
      className="grid max-w-2xl gap-5"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Prefixes need a description"
            autoFocus
            required
          />
        </Field>
        <FormSelect
          label="Severity"
          value={severity}
          onChange={(v) => setSeverity((v as ComplianceSeverity) ?? "warning")}
          options={SEVERITIES}
        />
      </div>

      <Field label="Description" hint="Optional — why this rule exists">
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="min-h-16 text-[13px]"
        />
      </Field>

      <Field
        label="How to fix"
        hint="Optional — Markdown remediation guide shown with this rule's violations (headings, lists, `code`, **bold**, links)"
      >
        <Textarea
          value={remediation}
          onChange={(e) => setRemediation(e.target.value)}
          placeholder={"1. Open the device\n2. Set the missing field…"}
          className="min-h-28 font-mono text-[13px]"
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <FormSelect
          label="Applies to"
          value={objectType}
          onChange={(v) => setObjectType(v ?? "prefix")}
          options={OBJECT_TYPES}
        />
        <FormSelect
          label="Check"
          value={check}
          onChange={(v) => setCheck((v as ComplianceCheck) ?? "required")}
          options={CHECKS}
        />
      </div>

      {usesField && (
        <Field
          label="Field"
          hint="Model field name, e.g. description, dns_name, status"
        >
          <Input
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder="description"
            className="font-mono text-[13px]"
            required
          />
        </Field>
      )}
      {check === "regex" && (
        <Field label="Pattern" hint="Python regex the value must match">
          <Input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="^[a-z0-9.-]+$"
            className="font-mono text-[13px]"
            required
          />
        </Field>
      )}
      {check === "required_tag" && (
        <Field label="Tag slug" hint="Object must carry this tag">
          <Input
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            placeholder="monitored"
            className="font-mono text-[13px]"
            required
          />
        </Field>
      )}
      {check === "required_cf" && (
        <Field
          label="Custom-field key"
          hint="Object's custom_fields must set this"
        >
          <Input
            value={cfKey}
            onChange={(e) => setCfKey(e.target.value)}
            placeholder="owner"
            className="font-mono text-[13px]"
            required
          />
        </Field>
      )}

      <label className="flex items-center gap-2 border-t border-border pt-4 text-sm">
        <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(!!v)} />
        Enabled
      </label>

      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={save.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || save.isPending}>
          {save.isPending ? "Saving…" : isEdit ? "Save rule" : "Create rule"}
        </Button>
      </div>
    </form>
  )
}
