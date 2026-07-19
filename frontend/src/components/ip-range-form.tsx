import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type IPRange,
  type IPRangeWritePayload,
  type IPRoleOption,
  type Paginated,
  type Prefix,
  type Status,
  type TagOption,
  type VRFOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useFieldErrors } from "@/components/forms"
import { cidrHostRange } from "@/lib/prefix-tree"
import { PrefixPicker, prefixDetailKey } from "@/components/prefix-picker"

export interface IpRangeFormProps {
  range?: IPRange
  onSaved: (saved: IPRange) => void
  onCancel: () => void
}

const NONE = "__none__"

export function IpRangeForm({ range, onSaved, onCancel }: IpRangeFormProps) {
  const isEdit = !!range
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [startAddress, setStartAddress] = useState(range?.start_address ?? "")
  const [endAddress, setEndAddress] = useState(range?.end_address ?? "")
  const [statusId, setStatusId] = useState<string | null>(
    range?.status?.id ?? null
  )
  const [vrfId, setVrfId] = useState<string | null>(range?.vrf?.id ?? null)
  const [prefixId, setPrefixId] = useState<string | null>(
    range?.prefix?.id ?? null
  )
  const [roleId, setRoleId] = useState<string | null>(range?.role?.id ?? null)
  const [description, setDescription] = useState(range?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    range?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    range?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!range) return
    setStartAddress(range.start_address)
    setEndAddress(range.end_address)
    setStatusId(range.status?.id ?? null)
    setVrfId(range.vrf?.id ?? null)
    setPrefixId(range.prefix?.id ?? null)
    setRoleId(range.role?.id ?? null)
    setDescription(range.description)
    setTagIds(range.tags.map((t) => t.id))
    setCustomFields(range.custom_fields ?? {})
    reset()
  }, [range, reset])

  const statuses = useQuery({
    queryKey: ["statuses", "iprange"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=iprange&picker=1"),
    staleTime: 5 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
    staleTime: 10 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["ip-roles-picker"],
    queryFn: () => api<Paginated<IPRoleOption>>("/api/ip-roles/"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: IPRangeWritePayload = {
        start_address: startAddress.trim(),
        end_address: endAddress.trim(),
        status_id: statusId,
        vrf_id: vrfId,
        prefix_id: prefixId,
        role_id: roleId,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<IPRange>(`/api/ip-ranges/${range!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<IPRange>("/api/ip-ranges/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["ip-ranges"] })
      qc.invalidateQueries({ queryKey: ["ip-range", saved.id] })
      toast.success(
        isEdit
          ? `Updated ${saved.start_address}–${saved.end_address}`
          : `Created ${saved.start_address}–${saved.end_address}`
      )
      onSaved(saved)
    },
    onError: (err) => {
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
      className="grid gap-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <Field label="Start address" error={fieldErrors.start_address}>
          <Input
            autoFocus={!isEdit}
            required
            placeholder="10.0.10.10"
            value={startAddress}
            onChange={(e) => setStartAddress(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="End address" error={fieldErrors.end_address}>
          <Input
            required
            placeholder="10.0.10.50"
            value={endAddress}
            onChange={(e) => setEndAddress(e.target.value)}
            className="font-mono"
          />
        </Field>
      </div>

      <PrefixPicker
        label="Parent prefix"
        hint="optional — sets the VRF"
        value={prefixId}
        onChange={(v) => {
          setPrefixId(v)
          if (!v) return
          // Fetch the picked prefix (works for modal picks beyond the
          // combobox page too — the old find-in-first-page lookup didn't).
          qc.fetchQuery({
            queryKey: prefixDetailKey(v),
            queryFn: () => api<Prefix>(`/api/prefixes/${v}/`),
            staleTime: 10 * 60_000,
          }).then((p) => {
            // A range under a prefix inherits its VRF (the backend enforces
            // this too) — reflect it immediately.
            setVrfId(p.vrf?.id ?? null)
            // Pre-fill the span with the prefix's network → broadcast so the
            // user starts from the full subnet and narrows from there.
            const range = cidrHostRange(p.cidr)
            if (range) {
              setStartAddress(range.start)
              setEndAddress(range.end)
            }
          })
        }}
        noneLabel="No parent prefix"
        placeholder="No parent prefix"
        error={fieldErrors.prefix_id}
      />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Status" error={fieldErrors.status_id}>
          <Select
            value={statusId ?? NONE}
            onValueChange={(v) => setStatusId(v === NONE ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No status</SelectItem>
              {statuses.data?.results.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="VRF"
          hint={prefixId ? "from prefix" : undefined}
          error={fieldErrors.vrf_id}
        >
          <Select
            value={vrfId ?? NONE}
            onValueChange={(v) => setVrfId(v === NONE ? null : v)}
            disabled={!!prefixId}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Global" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Global</SelectItem>
              {vrfs.data?.results.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}{" "}
                  {v.rd && (
                    <span className="text-muted-foreground">· {v.rd}</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Role" hint="optional" error={fieldErrors.role_id}>
        <Select
          value={roleId ?? NONE}
          onValueChange={(v) => setRoleId(v === NONE ? null : v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="No role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No role</SelectItem>
            {roles.data?.results.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                {r.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. DHCP pool — floor 3 wireless"
        />
      </Field>

      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>

      <CustomFieldInputs
        model="iprange"
        value={customFields}
        onChange={setCustomFields}
      />

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create IP range"}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-xs">{label}</Label>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
