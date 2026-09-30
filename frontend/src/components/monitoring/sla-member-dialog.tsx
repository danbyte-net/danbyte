import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DeviceRoleOption,
  Paginated,
  SlaCheckGroup,
  SlaObjectType,
} from "@/lib/api"
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
import { DeviceTypePicker } from "@/components/device-type-picker"
import { IpPicker } from "@/components/ip-picker"
import { PrefixPicker } from "@/components/prefix-picker"
import { VirtualChassisPicker } from "@/components/virtual-chassis-picker"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { selectorFieldsSet, selectorShrinks } from "./sla-members"

/** A member kind: an object, or a role or type the group's selector joins. */
type MemberKind = SlaObjectType | "role" | "type"

const KINDS: { value: MemberKind; label: string }[] = [
  { value: "api.device", label: "Device" },
  { value: "api.virtualchassis", label: "Virtual chassis" },
  { value: "role", label: "Device role" },
  { value: "type", label: "Device type" },
  { value: "api.virtualmachine", label: "Virtual machine" },
  { value: "api.ipaddress", label: "IP address" },
  { value: "api.prefix", label: "Prefix" },
  { value: "api.circuit", label: "Circuit" },
]

/** The group PATCH that adds a role or type to its selector, or null when
 * it is already there. Other selector fields are left as they are. */
export function selectorPatch(
  g: SlaCheckGroup,
  kind: "role" | "type",
  id: string
): Partial<SlaCheckGroup> | null {
  const field = kind === "role" ? "match_roles" : "match_device_types"
  if (g.use_selector && g[field].includes(id)) return null
  return {
    use_selector: true,
    [field]: g[field].includes(id) ? g[field] : [...g[field], id],
  }
}

/** Add one object to an agreement's group, or a role or type to its
 * selector. */
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
  const qc = useQueryClient()
  const [type, setType] = useState<MemberKind>("api.device")
  const [objectId, setObjectId] = useState<string | null>(null)
  const [group, setGroup] = useState<string | null>(groups[0]?.id ?? null)
  const bySelector = type === "role" || type === "type"
  const picked = groups.find((g) => g.id === group)
  const field = type === "role" ? "roles" : "types"
  const narrowedBy =
    picked && bySelector ? selectorFieldsSet(picked, field) : []
  const shrinks = !!picked && bySelector && selectorShrinks(picked, field)
  const [redundancy, setRedundancy] = useState("")
  const [monitorIp, setMonitorIp] = useState<string | null>(null)
  const circuits = useQuery({
    queryKey: ["circuits-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; cid: string; provider: { name: string } }>>(
        "/api/circuits/?page_size=1000"
      ),
    enabled: open && type === "api.circuit",
    staleTime: 5 * 60_000,
  })
  const vms = useQuery({
    queryKey: ["vms-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>(
        "/api/virtual-machines/?picker=1"
      ),
    enabled: open && type === "api.virtualmachine",
    staleTime: 5 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["device-roles-picker"],
    queryFn: () =>
      api<Paginated<DeviceRoleOption>>("/api/device-roles/?picker=1"),
    enabled: open && type === "role",
    staleTime: 10 * 60_000,
  })
  const add = useMutation({
    mutationFn: async (): Promise<string> => {
      if (type === "role" || type === "type") {
        const patch =
          picked && objectId && selectorPatch(picked, type, objectId)
        if (!patch) return "Already in the group's selector"
        await api(`/api/monitoring/sla-check-groups/${group}/`, {
          method: "PATCH",
          body: JSON.stringify(patch),
        })
        await qc.invalidateQueries({ queryKey: ["sla-groups", agreementId] })
        return "Selector updated"
      }
      const r = await api<{ created: number; skipped: number }>(
        "/api/monitoring/sla-members/bulk-add/",
        {
          method: "POST",
          body: JSON.stringify({
            agreement: agreementId,
            group,
            redundancy_group: redundancy.trim(),
            monitor_ip: type === "api.circuit" ? monitorIp : null,
            objects: [{ object_type: type, object_id: objectId }],
          }),
        }
      )
      return r.created ? "Member added" : "Already a member of that group"
    },
    onSuccess: (message) => {
      toast.success(message)
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
              setType(v as MemberKind)
              setObjectId(null)
              setMonitorIp(null)
            }}
            options={KINDS}
          />
          {type === "api.circuit" && (
            <>
              <FormCombobox
                label="Circuit"
                required
                value={objectId}
                onChange={setObjectId}
                options={(circuits.data?.results ?? []).map((c) => ({
                  value: c.id,
                  label: c.cid,
                  hint: c.provider.name,
                }))}
                placeholder="Pick a circuit"
                searchPlaceholder="Search circuits…"
                emptyText="No circuits."
              />
              <IpPicker
                label="Monitor address"
                value={monitorIp}
                onChange={setMonitorIp}
                info="Read the checks on this address, such as the provider's far-end gateway. Empty: the addresses cabled to the circuit's ends."
              />
            </>
          )}
          {type === "api.device" && (
            <DevicePicker value={objectId} onChange={setObjectId} required />
          )}
          {type === "api.virtualchassis" && (
            <VirtualChassisPicker
              value={objectId}
              onChange={setObjectId}
              required
              info="Counts once, on the master's primary address - else the first member's that has one."
            />
          )}
          {type === "role" && (
            <FormCombobox
              label="Device role"
              required
              value={objectId}
              onChange={setObjectId}
              options={(roles.data?.results ?? []).map((r) => ({
                value: r.id,
                label: r.name,
                color: r.color,
              }))}
              placeholder="Pick a role"
              searchPlaceholder="Search roles…"
              emptyText="No roles."
            />
          )}
          {type === "type" && (
            <DeviceTypePicker
              value={objectId}
              onChange={setObjectId}
              required
            />
          )}
          {bySelector && (
            <div className="space-y-1 text-[13px] text-muted-foreground">
              <p>
                Joins the group&apos;s selector. Matching devices count from the
                start of the period.
              </p>
              {narrowedBy.length > 0 && (
                <p>
                  Also narrowed by the selector&apos;s {narrowedBy.join(", ")}.
                </p>
              )}
              {shrinks && (
                <p className="text-amber-600 dark:text-amber-400">
                  Devices the selector matches now leave the group, for the
                  whole period, unless they{" "}
                  {type === "role" ? "have this role" : "are this type"}.
                </p>
              )}
            </div>
          )}
          {type === "api.ipaddress" && (
            <IpPicker value={objectId} onChange={setObjectId} required />
          )}
          {type === "api.prefix" && (
            <PrefixPicker value={objectId} onChange={setObjectId} required />
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
          {!bySelector && (
            <FormText
              label="Redundancy group"
              value={redundancy}
              onChange={setRedundancy}
              placeholder="leaf-pair-1"
              info="Members with the same label count as down only while all of them are down."
            />
          )}
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
              {add.isPending ? "Adding…" : "Add"}
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
              {save.isPending ? "Saving…" : "Exclude"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
