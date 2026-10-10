import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ComplianceCheck,
  type ComplianceRule,
  type ComplianceSeverity,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  FormCheckbox,
  FormColumn,
  FormColumns,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  type SelectOption,
} from "@/components/forms"
import { apiErrorToast } from "@/lib/api-toast"

const OBJECT_TYPES = [
  { value: "prefix", label: "Prefix" },
  { value: "ipaddress", label: "IP address" },
  { value: "device", label: "Device" },
  { value: "vlan", label: "VLAN" },
  { value: "vrf", label: "VRF" },
  { value: "site", label: "Site" },
  { value: "virtualmachine", label: "Virtual machine" },
]
const CHECKS: { value: ComplianceCheck; label: string }[] = [
  { value: "required", label: "Field must be set" },
  { value: "forbidden", label: "Field must be empty" },
  { value: "regex", label: "Field must match a pattern" },
  { value: "required_tag", label: "Must carry a tag" },
  { value: "required_cf", label: "Custom field must be set" },
  { value: "eol_status", label: "End-of-life status" },
]
// An end-of-life check reads the object's platform mapping (#8), so it only
// applies to the types that carry a platform.
const EOL_TYPES = new Set(["device", "virtualmachine"])
const EOL_FAIL_ON: SelectOption[] = [
  { value: "eol", label: "End of life" },
  { value: "ending", label: "Support ending or ended" },
  { value: "unknown", label: "No end-of-life data" },
]

// Compliance severity is a fixed scale rather than a catalog row, but it is
// rendered as a tinted pill wherever violations show up - the picker uses the
// same pill so the two never disagree.
const SEV_VARIANT: Record<
  ComplianceSeverity,
  "destructive" | "warning" | "secondary"
> = { critical: "destructive", warning: "warning", info: "secondary" }

const SEVERITIES: SelectOption[] = (
  ["critical", "warning", "info"] as ComplianceSeverity[]
).map((s) => ({
  value: s,
  label: (
    <Badge variant={SEV_VARIANT[s]} className="capitalize">
      {s}
    </Badge>
  ),
}))

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
  const [eolFailOn, setEolFailOn] = useState<string>(rule?.eol_fail_on || "eol")

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
        eol_fail_on: check === "eol_status" ? eolFailOn : "",
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
      className="@container grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Rule" card>
            <FormText
              label="Name"
              required
              autoFocus
              value={name}
              onChange={setName}
              placeholder="Prefixes need a description"
            />

            <FormSelect
              label="Severity"
              value={severity}
              onChange={(v) =>
                setSeverity((v as ComplianceSeverity) ?? "warning")
              }
              options={SEVERITIES}
            />

            <FormTextarea
              label="Description"
              hint="Why this rule exists"
              value={description}
              onChange={setDescription}
              rows={3}
            />

            <FormCheckbox
              label="Enabled"
              checked={enabled}
              onChange={setEnabled}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Check" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormSelect
                label="Applies to"
                required
                value={objectType}
                onChange={(v) => setObjectType(v ?? "prefix")}
                options={OBJECT_TYPES}
              />
              <FormSelect
                label="Check"
                required
                value={check}
                onChange={(v) => setCheck((v as ComplianceCheck) ?? "required")}
                options={CHECKS.filter(
                  (c) => c.value !== "eol_status" || EOL_TYPES.has(objectType)
                )}
              />
            </div>

            {usesField && (
              <FormText
                label="Field"
                required
                mono
                value={field}
                onChange={setField}
                placeholder="description"
                hint="Model field name, e.g. description, dns_name, status"
              />
            )}
            {check === "regex" && (
              <FormText
                label="Pattern"
                required
                mono
                value={pattern}
                onChange={setPattern}
                placeholder="^[a-z0-9.-]+$"
                hint="Python regex the value must match"
              />
            )}
            {check === "required_tag" && (
              <FormText
                label="Tag slug"
                required
                mono
                value={tag}
                onChange={setTag}
                placeholder="monitored"
                hint="Object must carry this tag"
              />
            )}
            {check === "eol_status" && (
              <FormSelect
                label="Fails on"
                required
                value={eolFailOn}
                onChange={(v) => setEolFailOn(v ?? "eol")}
                options={EOL_FAIL_ON}
                hint="The platform's end-of-life status"
              />
            )}
            {check === "required_cf" && (
              <FormText
                label="Custom-field key"
                required
                mono
                value={cfKey}
                onChange={setCfKey}
                placeholder="owner"
                hint="Object's custom_fields must set this"
              />
            )}
          </FormSection>

          <FormSection title="Remediation" card>
            <FormTextarea
              label="How to fix"
              hint="Markdown guide shown with this rule's violations - headings, lists, `code`, **bold**, links"
              value={remediation}
              onChange={setRemediation}
              rows={6}
              placeholder={"1. Open the device\n2. Set the missing field…"}
            />
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save rule" : "Create rule"}
      />
    </form>
  )
}
