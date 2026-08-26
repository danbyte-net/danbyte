import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type AlertRule,
  type AlertSeverity,
  type CheckKind,
  type CheckStatus,
  type Paginated,
  type Prefix,
  type TagOption,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Field,
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormTags,
  FormText,
  type SelectOption,
} from "@/components/forms"
import { CheckStatusBadge } from "./status-badge"
import { KINDS } from "./check-fields"
import { apiErrorToast } from "@/lib/api-toast"

const TRIGGER_STATUSES: CheckStatus[] = ["down", "stale", "degraded"]

// Severity is a fixed policy scale, not a catalog row - but it renders as a
// tinted badge in the rules table, so the picker shows the same pill rather
// than bare text.
const SEV_VARIANT: Record<
  AlertSeverity,
  "destructive" | "warning" | "secondary"
> = { critical: "destructive", warning: "warning", info: "secondary" }

const SEVERITIES: SelectOption[] = (
  ["critical", "warning", "info"] as AlertSeverity[]
).map((s) => ({
  value: s,
  label: (
    <Badge variant={SEV_VARIANT[s]} className="capitalize">
      {s}
    </Badge>
  ),
}))

export function RuleForm({
  rule,
  onSaved,
  onCancel,
}: {
  rule?: AlertRule
  onSaved: () => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const isEdit = !!rule

  const [name, setName] = useState(rule?.name ?? "")
  const [severity, setSeverity] = useState<AlertSeverity>(
    rule?.severity ?? "critical"
  )
  const [weight, setWeight] = useState(String(rule?.weight ?? 100))
  const [enabled, setEnabled] = useState(rule?.enabled ?? true)
  const [kinds, setKinds] = useState<CheckKind[]>(rule?.match_kinds ?? [])
  const [statuses, setStatuses] = useState<CheckStatus[]>(
    rule?.match_statuses ?? []
  )
  const [prefixId, setPrefixId] = useState<string | null>(
    rule?.match_prefix ?? null
  )
  const [tagIds, setTagIds] = useState<number[]>([])

  const tagsQ = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const prefixesQ = useQuery({
    queryKey: ["prefixes-picker"],
    queryFn: () => api<Paginated<Prefix>>("/api/prefixes/"),
    staleTime: 5 * 60_000,
  })

  // Edit: map the rule's stored tag slugs → ids for the picker, once tags load.
  useEffect(() => {
    if (!rule || !tagsQ.data) return
    const bySlug = new Map(tagsQ.data.results.map((t) => [t.slug, t.id]))
    setTagIds(
      rule.match_tag_slugs
        .map((s) => bySlug.get(s))
        .filter((x): x is number => x != null)
    )
  }, [rule, tagsQ.data])

  const save = useMutation({
    mutationFn: () => {
      const byId = new Map(
        (tagsQ.data?.results ?? []).map((t) => [t.id, t.slug])
      )
      const body = {
        name: name.trim(),
        enabled,
        severity,
        weight: Number(weight) || 100,
        match_kinds: kinds,
        match_statuses: statuses,
        match_tag_slugs: tagIds
          .map((id) => byId.get(id))
          .filter((s): s is string => !!s),
        match_prefix: prefixId,
      }
      return isEdit
        ? api(`/api/monitoring/alert-rules/${rule!.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/monitoring/alert-rules/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-rules"] })
      toast.success(isEdit ? `Saved ${name.trim()}` : `Created ${name.trim()}`)
      onSaved()
    },
    onError: (err) => apiErrorToast(err),
  })

  const toggle = <T,>(arr: T[], v: T, set: (a: T[]) => void) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (name.trim()) save.mutate()
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Rule" card>
        <FormText
          label="Name"
          required
          autoFocus
          value={name}
          onChange={setName}
          placeholder="Critical infra down"
        />

        <div className="grid gap-3 @md:grid-cols-2">
          <FormSelect
            label="Severity"
            value={severity}
            onChange={(v) => setSeverity((v as AlertSeverity) ?? "critical")}
            options={SEVERITIES}
          />
          <FormText
            label="Weight"
            type="number"
            mono
            value={weight}
            onChange={setWeight}
            info="Lower weights match first - the first matching rule sets the alert's severity."
          />
        </div>

        <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
      </FormSection>

      <FormSection title="Matchers" card>
        <Field
          label="Match check kinds"
          hint="Leave all unticked to match any kind."
        >
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {KINDS.map((k) => (
              <label
                key={k.value}
                className="flex items-center gap-2 text-[13px]"
              >
                <Checkbox
                  checked={kinds.includes(k.value)}
                  onCheckedChange={() => toggle(kinds, k.value, setKinds)}
                />
                {k.value}
              </label>
            ))}
          </div>
        </Field>

        <Field
          label="Trigger on status"
          hint="Leave all unticked to match any bad status."
        >
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {TRIGGER_STATUSES.map((s) => (
              <label key={s} className="flex items-center gap-2 text-[13px]">
                <Checkbox
                  checked={statuses.includes(s)}
                  onCheckedChange={() => toggle(statuses, s, setStatuses)}
                />
                <CheckStatusBadge status={s} />
              </label>
            ))}
          </div>
        </Field>

        <FormTags
          label="IP tags"
          hint="Only IPs carrying any of these tags. Empty = any."
          value={tagIds}
          onChange={setTagIds}
        />

        <FormCombobox
          label="Within prefix"
          value={prefixId}
          onChange={setPrefixId}
          noneLabel="Any prefix"
          placeholder="Any prefix"
          searchPlaceholder="Search prefixes…"
          emptyText="No prefixes."
          options={(prefixesQ.data?.results ?? []).map((p) => ({
            value: p.id,
            label: p.cidr,
          }))}
        />
      </FormSection>

      <FormFooter
        onCancel={onCancel}
        submitting={save.isPending}
        submitLabel={isEdit ? "Save rule" : "Create rule"}
      />
    </form>
  )
}
