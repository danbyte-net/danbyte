import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, SlaCheckGroup, SlaObjectType } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  Field,
  FormCombobox,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"
import { IpPicker } from "@/components/ip-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

/** Add one device, VM or address to an agreement's group. */
export function SlaMemberDialog({
  agreementId,
  groups,
  open,
  onOpenChange,
  onAdded,
}: {
  agreementId: string
  groups: SlaCheckGroup[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}) {
  const [type, setType] = useState<SlaObjectType>("api.device")
  const [objectId, setObjectId] = useState<string | null>(null)
  const [group, setGroup] = useState<string | null>(groups[0]?.id ?? null)
  const [redundancy, setRedundancy] = useState("")
  const vms = useQuery({
    queryKey: ["vms-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/virtual-machines/?picker=1"
      ),
    enabled: open && type === "api.virtualmachine",
    staleTime: 5 * 60_000,
  })
  const add = useMutation({
    mutationFn: () =>
      api<{ created: number; skipped: number }>(
        "/api/monitoring/sla-members/bulk-add/",
        {
          method: "POST",
          body: JSON.stringify({
            agreement: agreementId,
            group,
            redundancy_group: redundancy.trim(),
            objects: [{ object_type: type, object_id: objectId }],
          }),
        }
      ),
    onSuccess: (r) => {
      toast.success(
        r.created ? "Member added" : "Already a member of that group"
      )
      setObjectId(null)
      onAdded()
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add member</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            add.mutate()
          }}
        >
          <FormSelect
            label="Group"
            value={group ?? ""}
            onChange={setGroup}
            options={groups.map((g) => ({ value: g.id, label: g.name }))}
          />
          <FormSelect
            label="Kind"
            value={type}
            onChange={(v) => {
              setType(v as SlaObjectType)
              setObjectId(null)
            }}
            options={[
              { value: "api.device", label: "Device" },
              { value: "api.virtualmachine", label: "Virtual machine" },
              { value: "api.ipaddress", label: "IP address" },
            ]}
          />
          {type === "api.device" && (
            <DevicePicker value={objectId} onChange={setObjectId} required />
          )}
          {type === "api.ipaddress" && (
            <IpPicker value={objectId} onChange={setObjectId} required />
          )}
          {type === "api.virtualmachine" && (
            <FormCombobox
              label="Virtual machine"
              required
              value={objectId}
              onChange={setObjectId}
              options={(vms.data?.results ?? []).map((v) => ({
                value: v.id,
                label: v.name,
              }))}
              placeholder="Pick a VM"
              searchPlaceholder="Search VMs…"
              emptyText="No virtual machines."
            />
          )}
          <FormText
            label="Redundancy group"
            value={redundancy}
            onChange={setRedundancy}
            placeholder="leaf-pair-1"
            info="Members with the same label count as down only while all of them are down."
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!objectId || !group || add.isPending}
            >
              {add.isPending ? "Adding..." : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function toLocalInput(iso: string): string {
  const d = new Date(iso)
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16)
}

/** Excuse a stretch of time - for the whole agreement or one member - with
 * a reason. Refused once the period it touches is frozen. */
export function SlaExclusionDialog({
  agreementId,
  members,
  open,
  onOpenChange,
  onSaved,
}: {
  agreementId: string
  members: { id: string; name: string }[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const now = new Date().toISOString()
  const [start, setStart] = useState(toLocalInput(now))
  const [end, setEnd] = useState(toLocalInput(now))
  const [member, setMember] = useState<string | null>(null)
  const [reason, setReason] = useState("")
  const save = useMutation({
    mutationFn: () => {
      reset()
      return api("/api/monitoring/sla-exclusions/", {
        method: "POST",
        body: JSON.stringify({
          agreement: agreementId,
          member,
          starts_at: new Date(start).toISOString(),
          ends_at: new Date(end).toISOString(),
          reason: reason.trim(),
        }),
      })
    },
    onSuccess: () => {
      toast.success("Time excluded")
      setReason("")
      onSaved()
      onOpenChange(false)
    },
    onError: (e) => {
      const msg = handleApiError(e)
      if (msg) toast.error(msg)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Exclude time</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="From" required error={fieldErrors.starts_at}>
              <Input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </Field>
            <Field label="To" required error={fieldErrors.ends_at}>
              <Input
                type="datetime-local"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </Field>
          </div>
          <FormCombobox
            label="Member"
            value={member}
            onChange={setMember}
            options={members.map((m) => ({ value: m.id, label: m.name }))}
            noneLabel="Whole agreement"
            placeholder="Whole agreement"
            emptyText="No members."
            error={fieldErrors.member}
          />
          <FormTextarea
            label="Reason"
            value={reason}
            onChange={setReason}
            required
            rows={3}
            placeholder="Provider fibre cut, ticket 4411"
            error={fieldErrors.reason}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving..." : "Exclude"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
