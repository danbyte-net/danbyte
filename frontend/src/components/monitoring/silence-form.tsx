import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type CheckKind,
  type CheckStatus,
  type Paginated,
  type Prefix,
  type Silence,
  type TagOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FormCombobox, FormTags } from "@/components/forms"
import { KINDS } from "./check-fields"
import { apiErrorToast } from "@/lib/api-toast"

const TRIGGER_STATUSES: CheckStatus[] = ["down", "stale", "degraded"]

// ISO ↔ <input type="datetime-local"> (which is local, no timezone suffix).
function toLocalInput(iso: string): string {
  const d = new Date(iso)
  const off = d.getTimezoneOffset() * 60000
  return new Date(d.getTime() - off).toISOString().slice(0, 16)
}
function fromLocalInput(v: string): string {
  return new Date(v).toISOString()
}

export function SilenceForm({
  silence,
  onSaved,
  onCancel,
}: {
  silence?: Silence
  onSaved: () => void
  onCancel: () => void
}) {
  const qc = useQueryClient()
  const isEdit = !!silence

  const nowLocal = toLocalInput(new Date().toISOString())
  const plus1h = toLocalInput(new Date(Date.now() + 3600_000).toISOString())

  const [reason, setReason] = useState(silence?.reason ?? "")
  const [startsAt, setStartsAt] = useState(
    silence ? toLocalInput(silence.starts_at) : nowLocal
  )
  const [endsAt, setEndsAt] = useState(
    silence ? toLocalInput(silence.ends_at) : plus1h
  )
  const [kinds, setKinds] = useState<CheckKind[]>(silence?.match_kinds ?? [])
  const [statuses, setStatuses] = useState<CheckStatus[]>(
    silence?.match_statuses ?? []
  )
  const [prefixId, setPrefixId] = useState<string | null>(
    silence?.match_prefix ?? null
  )
  const [ipId, setIpId] = useState<string | null>(silence?.match_ip ?? null)
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
  const ipsQ = useQuery({
    queryKey: ["ips-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; ip_address: string }>>(
        "/api/ips/?page_size=500"
      ),
    staleTime: 5 * 60_000,
  })

  useEffect(() => {
    if (!silence || !tagsQ.data) return
    const bySlug = new Map(tagsQ.data.results.map((t) => [t.slug, t.id]))
    setTagIds(
      silence.match_tag_slugs
        .map((s) => bySlug.get(s))
        .filter((x): x is number => x != null)
    )
  }, [silence, tagsQ.data])

  const save = useMutation({
    mutationFn: () => {
      const byId = new Map(
        (tagsQ.data?.results ?? []).map((t) => [t.id, t.slug])
      )
      const body = {
        reason: reason.trim(),
        starts_at: fromLocalInput(startsAt),
        ends_at: fromLocalInput(endsAt),
        match_kinds: kinds,
        match_statuses: statuses,
        match_tag_slugs: tagIds
          .map((id) => byId.get(id))
          .filter((s): s is string => !!s),
        match_prefix: prefixId,
        match_ip: ipId,
      }
      return isEdit
        ? api(`/api/monitoring/silences/${silence!.id}/`, {
            method: "PATCH",
            body: JSON.stringify(body),
          })
        : api("/api/monitoring/silences/", {
            method: "POST",
            body: JSON.stringify(body),
          })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["silences"] })
      qc.invalidateQueries({ queryKey: ["alerts"] })
      toast.success(isEdit ? "Silence saved" : "Silence created")
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
        save.mutate()
      }}
      className="grid max-w-2xl gap-5"
    >
      <Field label="Reason" hint="Why alerts are muted — shown in the list.">
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Datacenter A maintenance"
          autoFocus
        />
      </Field>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Starts">
          <Input
            type="datetime-local"
            value={startsAt}
            onChange={(e) => setStartsAt(e.target.value)}
            required
          />
        </Field>
        <Field label="Ends">
          <Input
            type="datetime-local"
            value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)}
            required
          />
        </Field>
      </div>

      <div className="rounded-md border border-dashed border-border p-3">
        <p className="mb-3 text-[11px] tracking-[0.08em] text-muted-foreground uppercase">
          Matchers — leave everything empty for a blanket maintenance window
        </p>
        <div className="space-y-4">
          <Field label="Check kinds" hint="empty = any">
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

          <Field label="Statuses" hint="empty = any">
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
            hint="Only IPs carrying any of these tags."
            value={tagIds}
            onChange={setTagIds}
          />

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
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
            <FormCombobox
              label="Single IP"
              value={ipId}
              onChange={setIpId}
              noneLabel="Any IP"
              placeholder="Any IP"
              searchPlaceholder="Search IPs…"
              emptyText="No IPs."
              options={(ipsQ.data?.results ?? []).map((ip) => ({
                value: ip.id,
                label: ip.ip_address,
              }))}
            />
          </div>
        </div>
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
        <Button type="submit" disabled={save.isPending}>
          {save.isPending
            ? "Saving…"
            : isEdit
              ? "Save silence"
              : "Create silence"}
        </Button>
      </div>
    </form>
  )
}
