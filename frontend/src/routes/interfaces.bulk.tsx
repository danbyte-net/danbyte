import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useMemo, useState } from "react"
import { toast } from "sonner"

import { api, type Paginated, type TagOption, type VLANOption } from "@/lib/api"
import { EditPageShell } from "@/components/edit-page-shell"
import {
  Field,
  FormCheckbox,
  FormSelect,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { Button } from "@/components/ui/button"
import { DevicePicker } from "@/components/device-picker"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"

export const Route = createFileRoute("/interfaces/bulk")({
  component: BulkInterfacesPage,
  validateSearch: (s: Record<string, unknown>): { device?: string } =>
    typeof s.device === "string" ? { device: s.device } : {},
})

// Expand a name pattern with a single numeric range, e.g. "eth[0-47]" →
// eth0..eth47. Preserves zero-padding ("Gi1/0/[01-48]" → Gi1/0/01…). Returns
// [pattern] when there's no range, [] when the range is invalid/too large.
function expandPattern(pattern: string): string[] {
  const p = pattern.trim()
  if (!p) return []
  const m = p.match(/^(.*)\[(\d+)-(\d+)\](.*)$/)
  if (!m) return [p]
  const [, pre, a, b, post] = m
  const start = parseInt(a, 10)
  const end = parseInt(b, 10)
  if (isNaN(start) || isNaN(end) || end < start || end - start > 511) return []
  const pad = a.length > 1 && a.startsWith("0") ? a.length : 0
  const out: string[] = []
  for (let i = start; i <= end; i++) {
    out.push(`${pre}${pad ? String(i).padStart(pad, "0") : i}${post}`)
  }
  return out
}

function BulkInterfacesPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const { device: presetDevice } = Route.useSearch()
  const { fieldErrors, handleApiError } = useFieldErrors()

  const [deviceId, setDeviceId] = useState<string | null>(presetDevice ?? null)
  const [pattern, setPattern] = useState("")
  const [speed, setSpeed] = useState("")
  const [mtu, setMtu] = useState("")
  const [enabled, setEnabled] = useState(true)
  const [vlanId, setVlanId] = useState<string | null>(null)
  const [tagIds, setTagIds] = useState<number[]>([])

  const names = useMemo(() => expandPattern(pattern), [pattern])

  const vlans = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () => api<Paginated<VLANOption>>("/api/vlans/"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: () =>
      api<{ created: number; skipped: string[] }>(
        "/api/interfaces/bulk-create/",
        {
          method: "POST",
          body: JSON.stringify({
            device_id: deviceId,
            names,
            speed: speed.trim(),
            mtu: mtu.trim() === "" ? null : Number(mtu),
            enabled,
            vlan_id: vlanId,
            tag_ids: tagIds,
          }),
        }
      ),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["interfaces"] })
      qc.invalidateQueries({ queryKey: ["device-interfaces"] })
      const skipped = r.skipped?.length
        ? `, skipped ${r.skipped.length} existing`
        : ""
      toast.success(
        `Created ${r.created} interface${r.created === 1 ? "" : "s"}${skipped}`
      )
      if (deviceId) nav({ to: "/devices/$id", params: { id: deviceId } })
      else nav({ to: "/interfaces" })
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <EditPageShell
      crumbs={[
        { label: "Interfaces", to: "/interfaces" },
        { label: "Bulk add" },
      ]}
      title="Bulk add interfaces"
      subtitle="Create many ports at once with a numeric range, e.g. eth[0-47]."
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          mutation.mutate()
        }}
        className="grid gap-4"
      >
        <DevicePicker
          value={deviceId}
          onChange={setDeviceId}
          error={fieldErrors.device_id}
        />
        <FormText
          label="Name pattern"
          required
          value={pattern}
          onChange={setPattern}
          mono
          placeholder="GigabitEthernet1/0/[1-48]"
          hint="Use [start-end] for a numeric range"
          error={fieldErrors.names}
        />
        <Field label={`Preview · ${names.length}`}>
          {names.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Enter a pattern to preview the names.
            </p>
          ) : (
            <div className="max-h-40 overflow-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-[11px]">
              {names.slice(0, 200).join(", ")}
              {names.length > 200 ? ` … (+${names.length - 200} more)` : ""}
            </div>
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <FormText
            label="Speed"
            value={speed}
            onChange={setSpeed}
            placeholder="10G"
          />
          <FormText
            label="MTU"
            type="number"
            value={mtu}
            onChange={setMtu}
            placeholder="1500"
          />
        </div>
        <FormSelect
          label="VLAN"
          value={vlanId}
          onChange={setVlanId}
          noneLabel="No VLAN"
          options={(vlans.data?.results ?? []).map((v) => ({
            value: v.id,
            label: `${v.vlan_id} · ${v.name}`,
          }))}
        />
        <FormCheckbox label="Enabled" checked={enabled} onChange={setEnabled} />
        <Field label="Tags">
          <TagMultiSelect
            options={tags.data?.results ?? []}
            value={tagIds}
            onChange={setTagIds}
          />
        </Field>
        <div className="mt-2 flex items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={() => nav({ to: "/interfaces" })}
            disabled={mutation.isPending}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={mutation.isPending || !deviceId || names.length === 0}
          >
            {mutation.isPending
              ? "Creating…"
              : `Create ${names.length} interface${names.length === 1 ? "" : "s"}`}
          </Button>
        </div>
      </form>
    </EditPageShell>
  )
}
