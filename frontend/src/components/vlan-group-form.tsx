import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type VLANGroup,
  type VLANGroupWritePayload,
} from "@/lib/api"

type ClusterPick = { id: string; name: string }
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
import { useFieldErrors } from "@/components/forms"

export interface VlanGroupFormProps {
  group?: VLANGroup
  onSaved: (g: VLANGroup) => void
  onCancel: () => void
}

const NONE = "__none__"

export function VlanGroupForm({
  group,
  onSaved,
  onCancel,
}: VlanGroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(group?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(group?.site?.id ?? null)
  const [clusterId, setClusterId] = useState<string | null>(
    group?.cluster?.id ?? null
  )
  const [minVid, setMinVid] = useState<string>(
    group ? String(group.min_vid) : "1"
  )
  const [maxVid, setMaxVid] = useState<string>(
    group ? String(group.max_vid) : "4094"
  )
  const [description, setDescription] = useState(group?.description ?? "")

  useEffect(() => {
    if (!group) return
    setName(group.name)
    setSiteId(group.site?.id ?? null)
    setClusterId(group.cluster?.id ?? null)
    setMinVid(String(group.min_vid))
    setMaxVid(String(group.max_vid))
    setDescription(group.description)
    reset()
  }, [group, reset])

  const sites = useSiteOptions()
  const clusters = useQuery({
    queryKey: ["clusters-picker"],
    queryFn: () => api<Paginated<ClusterPick>>("/api/clusters/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: VLANGroupWritePayload = {
        name: name.trim(),
        site_id: siteId,
        cluster_id: clusterId,
        min_vid: Number(minVid),
        max_vid: Number(maxVid),
        description: description.trim(),
      }
      if (isEdit)
        return api<VLANGroup>(`/api/vlan-groups/${group!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<VLANGroup>("/api/vlan-groups/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["vlan-groups"] })
      qc.invalidateQueries({ queryKey: ["vlan-groups-picker"] })
      qc.invalidateQueries({ queryKey: ["vlan-group", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
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
      <Field label="Name" error={fieldErrors.name}>
        <Input
          autoFocus={!isEdit}
          required
          placeholder="Campus access VLANs"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Min VID" error={fieldErrors.min_vid}>
          <Input
            required
            type="number"
            min={1}
            max={4094}
            value={minVid}
            onChange={(e) => setMinVid(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="Max VID" error={fieldErrors.max_vid}>
          <Input
            required
            type="number"
            min={1}
            max={4094}
            value={maxVid}
            onChange={(e) => setMaxVid(e.target.value)}
            className="font-mono"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Site" hint="optional" error={fieldErrors.site_id}>
          <Select
            value={siteId ?? NONE}
            onValueChange={(v) => setSiteId(v === NONE ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No site" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No site</SelectItem>
              {sites.options.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Cluster" hint="optional" error={fieldErrors.cluster_id}>
          <Select
            value={clusterId ?? NONE}
            onValueChange={(v) => setClusterId(v === NONE ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No cluster" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No cluster</SelectItem>
              {clusters.data?.results.map((cl) => (
                <SelectItem key={cl.id} value={cl.id}>
                  {cl.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Access VLANs for the Amsterdam campus"
        />
      </Field>

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
              : "Create group"}
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
