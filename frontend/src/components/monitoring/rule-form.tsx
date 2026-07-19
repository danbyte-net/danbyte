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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FormCombobox, FormSelect, FormTags } from "@/components/forms"
import { KINDS } from "./check-fields"
import { apiErrorToast } from "@/lib/api-toast"

const TRIGGER_STATUSES: CheckStatus[] = ["down", "stale", "degraded"]
const SEVERITIES: { value: AlertSeverity; label: string }[] = [
  { value: "critical", label: "Critical" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
]

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
      className="grid max-w-2xl gap-5"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Critical infra down"
            autoFocus
            required
          />
        </Field>
        <FormSelect
          label="Severity"
          value={severity}
          onChange={(v) => setSeverity((v as AlertSeverity) ?? "critical")}
          options={SEVERITIES}
        />
      </div>

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
              {s}
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

      <div className="flex items-center justify-between border-t border-border pt-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={enabled}
            onCheckedChange={(v) => setEnabled(!!v)}
          />
          Enabled
        </label>
        <Field label="Weight" className="w-28">
          <Input
            type="number"
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
          />
        </Field>
      </div>

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
