import { useEffect, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation } from "@tanstack/react-query"
import { Layers3, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  DeviceProfileAssignment,
  DeviceProfileBulkItem,
  DeviceProfileBulkOutcome,
  DeviceProfileBulkResult,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { DevicePicker } from "@/components/device-picker"
import { VMPicker } from "@/components/vm-picker"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormCombobox } from "@/components/forms"
import {
  ASSIGN_ENDPOINT,
  useInvalidateProfileWork,
  useProfileOptions,
} from "@/components/device-profile-assign"

// "Apply profile" on the device and VM lists: one profile on every selected
// object. Up to 25 answer inline with each outcome; more run as a job.

const OUTCOME: Record<
  DeviceProfileBulkOutcome,
  { label: string; variant: "success" | "secondary" | "destructive" }
> = {
  assigned: { label: "Applied", variant: "success" },
  unassigned: { label: "Unassigned", variant: "secondary" },
  unchanged: { label: "Already had it", variant: "secondary" },
  denied: { label: "Not allowed", variant: "destructive" },
  refused: { label: "Refused", variant: "destructive" },
  failed: { label: "Failed", variant: "destructive" },
}

/** Objects one bulk request answers inline (the server's BULK_INLINE). */
export const BULK_INLINE = 25

/** Assign one profile to many objects in inline-sized batches, so every
 * object comes back with its outcome instead of a background job. */
export async function bulkAssignProfile(
  profileId: string,
  kind: "device" | "vm",
  ids: string[]
): Promise<{ results: DeviceProfileBulkItem[] }> {
  const results: DeviceProfileBulkItem[] = []
  for (let i = 0; i < ids.length; i += BULK_INLINE) {
    const r = await api<DeviceProfileBulkResult>(`${ASSIGN_ENDPOINT}bulk/`, {
      method: "POST",
      body: JSON.stringify({
        profile_id: profileId,
        action: "assign",
        [kind === "device" ? "device_ids" : "virtual_machine_ids"]: ids.slice(
          i,
          i + BULK_INLINE
        ),
      }),
    })
    if ("results" in r) results.push(...r.results)
  }
  return { results }
}

/** Toast for a bulk assign: the count assigned, then what was skipped and
 * why, grouped by reason. */
export function bulkAssignToast(results: DeviceProfileBulkItem[]) {
  const assigned = results.filter((r) => r.outcome === "assigned").length
  const skipped = results.filter((r) => r.outcome !== "assigned")
  if (skipped.length === 0) {
    toast.success(`Assigned ${assigned}`)
    return
  }
  const reasons = new Map<string, string[]>()
  for (const r of skipped) {
    const why = r.detail || OUTCOME[r.outcome].label
    reasons.set(why, [...(reasons.get(why) ?? []), r.name || r.id])
  }
  const lines = [...reasons].map(([why, names]) => {
    const shown = names.slice(0, 3).join(", ")
    const more = names.length > 3 ? ` +${names.length - 3}` : ""
    return `${why} ${shown}${more}`
  })
  toast.warning(`Assigned ${assigned} · skipped ${skipped.length}`, {
    description: lines.join("\n"),
  })
}

export function BulkApplyProfileDialog({
  kind,
  ids,
  open,
  onOpenChange,
  onDone,
}: {
  kind: "device" | "vm"
  ids: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Called when the dialog closes after a run. */
  onDone?: () => void
}) {
  const { can } = useMe()
  const invalidate = useInvalidateProfileWork()
  const options = useProfileOptions(open)
  const [profileId, setProfileId] = useState<string | null>(null)
  const [result, setResult] = useState<DeviceProfileBulkResult | null>(null)
  useEffect(() => {
    if (!open) return
    setProfileId(null)
    setResult(null)
  }, [open])

  const run = useMutation({
    mutationFn: () =>
      api<DeviceProfileBulkResult>(`${ASSIGN_ENDPOINT}bulk/`, {
        method: "POST",
        body: JSON.stringify({
          profile_id: profileId,
          action: "assign",
          [kind === "device" ? "device_ids" : "virtual_machine_ids"]: ids,
        }),
      }),
    onSuccess: (r) => {
      setResult(r)
      invalidate()
    },
    onError: (err) => apiErrorToast(err),
  })

  const close = () => {
    onOpenChange(false)
    if (result) onDone?.()
  }
  const noun =
    kind === "device"
      ? ids.length === 1
        ? "device"
        : "devices"
      : ids.length === 1
        ? "VM"
        : "VMs"

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(o) : close())}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>
            Apply profile to {ids.length} {noun}
          </DialogTitle>
        </DialogHeader>
        {result === null ? (
          <FormCombobox
            label="Profile"
            required
            value={profileId}
            onChange={setProfileId}
            options={(options.data?.results ?? []).map((o) => ({
              value: o.id,
              label: o.name,
              color: o.color || null,
              badge: true,
            }))}
            placeholder="Pick a profile…"
            searchPlaceholder="Search profiles…"
            emptyText="No profiles."
          />
        ) : "job_id" in result ? (
          <p className="text-sm">
            Queued for {result.count} {noun}.{" "}
            {can("jobs.manage") ? (
              <Link
                to="/jobs/$id"
                params={{ id: result.job_id }}
                className="link"
              >
                Open the job
              </Link>
            ) : (
              <span className="text-muted-foreground">It runs on Jobs.</span>
            )}
          </p>
        ) : (
          <div className="grid gap-3 text-sm">
            <div className="flex flex-wrap gap-1.5">
              {(Object.keys(OUTCOME) as DeviceProfileBulkOutcome[])
                .filter((k) => result.counts[k])
                .map((k) => (
                  <Badge key={k} variant={OUTCOME[k].variant} className="num">
                    {OUTCOME[k].label} {result.counts[k]}
                  </Badge>
                ))}
            </div>
            <ul className="grid max-h-72 gap-1 overflow-y-auto">
              {result.results.map((r) => (
                <li key={r.id} className="flex items-center gap-2">
                  {kind === "device" ? (
                    <Link
                      to="/devices/$id"
                      params={{ id: r.id }}
                      className="link"
                    >
                      {r.name || r.id}
                    </Link>
                  ) : (
                    <Link
                      to="/virtual-machines/$id"
                      params={{ id: r.id }}
                      className="link"
                    >
                      {r.name || r.id}
                    </Link>
                  )}
                  <Badge variant={OUTCOME[r.outcome].variant}>
                    {OUTCOME[r.outcome].label}
                  </Badge>
                  {r.detail && r.outcome !== "unchanged" && (
                    <span className="truncate text-xs text-muted-foreground">
                      {r.detail}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DialogFooter>
          {result === null ? (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={!profileId || run.isPending}
                onClick={() => run.mutate()}
              >
                {run.isPending ? "Applying…" : "Apply"}
              </Button>
            </>
          ) : (
            <Button onClick={close}>Done</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The bulk bar's "Apply profile" button and its dialog. */
export function ApplyProfileBulkButton({
  kind,
  ids,
  onDone,
}: {
  kind: "device" | "vm"
  ids: string[]
  onDone?: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2"
        onClick={() => setOpen(true)}
      >
        <Layers3 className="mr-1 h-3 w-3" /> Apply profile
      </Button>
      <BulkApplyProfileDialog
        kind={kind}
        ids={ids}
        open={open}
        onOpenChange={setOpen}
        onDone={onDone}
      />
    </>
  )
}

/** Whether the reader may apply profiles in bulk at all; the server checks
 * every object's site. */
export function useCanApplyProfiles() {
  const { canDo } = useMe()
  return canDo("deviceprofileassignment", "add")
}

type PickedHost = { id: string; label: string }

/** "Assign devices" on a profile's page: pick devices (and VMs, when the
 * profile is for them) and assign the profile to each, exactly as a single
 * assign does. Objects that already carry it are left out of the pickers. */
export function AssignObjectsDialog({
  profile,
  assigned,
  open,
  onOpenChange,
}: {
  profile: {
    id: string
    applies_to_devices: boolean
    applies_to_vms: boolean
  }
  /** Assignments the profile already has, hidden from the pickers. */
  assigned: DeviceProfileAssignment[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const invalidate = useInvalidateProfileWork()
  const kinds: ("device" | "vm")[] = [
    ...(profile.applies_to_devices ? (["device"] as const) : []),
    ...(profile.applies_to_vms ? (["vm"] as const) : []),
  ]
  const [kind, setKind] = useState<"device" | "vm">(kinds[0] ?? "device")
  const [picked, setPicked] = useState<Record<"device" | "vm", PickedHost[]>>({
    device: [],
    vm: [],
  })
  useEffect(() => {
    if (!open) return
    setPicked({ device: [], vm: [] })
    setKind(profile.applies_to_devices ? "device" : "vm")
  }, [open, profile.applies_to_devices])

  const taken = useMemo(
    () => ({
      device: assigned.flatMap((a) => (a.device ? [a.device.id] : [])),
      vm: assigned.flatMap((a) =>
        a.virtual_machine ? [a.virtual_machine.id] : []
      ),
    }),
    [assigned]
  )
  const total = picked.device.length + picked.vm.length

  const run = useMutation({
    mutationFn: async () => {
      const out: DeviceProfileBulkItem[] = []
      for (const k of ["device", "vm"] as const) {
        if (!picked[k].length) continue
        const r = await bulkAssignProfile(
          profile.id,
          k,
          picked[k].map((p) => p.id)
        )
        out.push(...r.results)
      }
      return out
    },
    onSuccess: (results) => {
      bulkAssignToast(results)
      invalidate()
      onOpenChange(false)
    },
    onError: (err) => {
      apiErrorToast(err)
      invalidate()
    },
  })

  const add = (items: PickedHost[]) =>
    setPicked((prev) => ({
      ...prev,
      [kind]: [
        ...prev[kind],
        ...items.filter((i) => !prev[kind].some((p) => p.id === i.id)),
      ],
    }))
  const remove = (k: "device" | "vm", id: string) =>
    setPicked((prev) => ({ ...prev, [k]: prev[k].filter((p) => p.id !== id) }))
  const pickerProps = {
    value: null,
    onChange: () => undefined,
    excludeIds: [...taken[kind], ...picked[kind].map((p) => p.id)],
    onPickMany: add,
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {kinds.length === 1 && kinds[0] === "vm"
              ? "Assign virtual machines"
              : "Assign devices"}
          </DialogTitle>
        </DialogHeader>
        {kinds.length > 1 && (
          <SegmentedTabs<"device" | "vm">
            items={[
              {
                value: "device",
                label: "Devices",
                count: picked.device.length || null,
              },
              {
                value: "vm",
                label: "Virtual machines",
                count: picked.vm.length || null,
              },
            ]}
            value={kind}
            onValueChange={setKind}
          />
        )}
        {kind === "device" ? (
          <DevicePicker label="Devices" {...pickerProps} />
        ) : (
          <VMPicker label="Virtual machines" {...pickerProps} />
        )}
        {total > 0 && (
          <div className="flex flex-wrap gap-1" data-testid="assign-picked">
            {(["device", "vm"] as const).flatMap((k) =>
              picked[k].map((p) => (
                <Badge key={p.id} variant="secondary" className="gap-1">
                  {p.label}
                  <button
                    type="button"
                    aria-label={`Remove ${p.label}`}
                    onClick={() => remove(k, p.id)}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))
            )}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={total === 0 || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? "Assigning…" : `Assign ${total || ""}`.trim()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
