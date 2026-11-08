import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  ApplicationGroupAssignment,
  ApplicationGroupMini,
  ApplicationGroupRelease,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { IdMultiSelect } from "@/components/cells/id-multi-select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FormFooter, useFieldErrors } from "@/components/forms"
import { ApplicationGroupPicker } from "@/components/application-group-picker"
import { DevicePicker } from "@/components/device-picker"
import { VMPicker } from "@/components/vm-picker"
import { SegmentedTabs } from "@/components/segmented-tabs"

// Assigning an application group to a device or VM (#436) records one
// install per member; unassigning removes the untouched ones it made.

export type GroupHost = { kind: "device" | "vm"; id: string }

const ENDPOINT = "/api/application-group-assignments/"

export const hostParam = (h: GroupHost) =>
  h.kind === "device" ? `device=${h.id}` : `virtual_machine=${h.id}`

const hostPayload = (h: GroupHost) =>
  h.kind === "device" ? { device_id: h.id } : { virtual_machine_id: h.id }

/** Everything an assignment changes: the host's software, the group's
 * counts and hosts, the lifecycle rows. */
export function useInvalidateGroupWork() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ["installed-software"] })
    qc.invalidateQueries({ queryKey: ["application-group-assignments"] })
    qc.invalidateQueries({ queryKey: ["application-groups"] })
    qc.invalidateQueries({ queryKey: ["application-group"] })
    qc.invalidateQueries({ queryKey: ["lifecycle"] })
  }
}

const HOST_KINDS = [
  { value: "device", label: "Device" },
  { value: "vm", label: "Virtual machine" },
] as const

/** Assign a group. Either the host is fixed (the Software tab) and the user
 * picks the group, or the group is fixed (its Hosts tab) and the user picks
 * a device or VM. */
export function AssignGroupDialog({
  host: fixedHost,
  group,
  assignedGroupIds,
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Groups already on the fixed host, left out of the picker. */
  assignedGroupIds?: string[]
} & (
  | { host: GroupHost; group?: undefined }
  | { host?: undefined; group: { id: string } }
)) {
  const invalidate = useInvalidateGroupWork()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [groupId, setGroupId] = useState<string | null>(null)
  const [kind, setKind] = useState<GroupHost["kind"]>("device")
  const [hostId, setHostId] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setGroupId(group?.id ?? null)
    setKind("device")
    setHostId(null)
    reset()
  }, [open, group?.id, reset])

  const host: GroupHost | null =
    fixedHost ?? (hostId ? { kind, id: hostId } : null)
  // "Already assigned here" comes back on the group; show it on the host.
  const hostError = (own: string) => own || fieldErrors.group_id

  const save = useMutation({
    mutationFn: () =>
      api<ApplicationGroupAssignment>(ENDPOINT, {
        method: "POST",
        body: JSON.stringify({
          group_id: groupId,
          ...(host ? hostPayload(host) : { device_id: null }),
        }),
      }),
    onSuccess: (a) => {
      const n = a.install_count
      toast.success(
        `Assigned ${a.group.name} · ${n} ${n === 1 ? "install" : "installs"}`
      )
      invalidate()
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Assign group</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="grid gap-4"
        >
          {fixedHost ? (
            <ApplicationGroupPicker
              required
              value={groupId}
              onChange={setGroupId}
              excludeIds={assignedGroupIds}
              error={fieldErrors.group_id}
            />
          ) : (
            <>
              <Field label="Assign to">
                <SegmentedTabs
                  items={HOST_KINDS}
                  value={kind}
                  onValueChange={(v) => {
                    if (v === kind) return
                    setKind(v)
                    setHostId(null)
                  }}
                />
              </Field>
              {kind === "device" ? (
                <DevicePicker
                  required
                  value={hostId}
                  onChange={setHostId}
                  error={hostError(fieldErrors.device_id)}
                />
              ) : (
                <VMPicker
                  required
                  value={hostId}
                  onChange={setHostId}
                  error={hostError(fieldErrors.virtual_machine_id)}
                />
              )}
            </>
          )}
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel="Assign"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Toast line for what an unassign did with the group's installs. */
export function releaseSummary(r: ApplicationGroupRelease): string {
  const parts: string[] = []
  if (r.removed) parts.push(`${r.removed} removed`)
  if (r.kept) parts.push(`${r.kept} kept`)
  if (r.moved) parts.push(`${r.moved} moved to another group`)
  return parts.join(" · ")
}

/** Unassign one group from one host. */
export function UnassignGroupDialog({
  assignment: a,
  onOpenChange,
}: {
  assignment: ApplicationGroupAssignment | null
  onOpenChange: (open: boolean) => void
}) {
  const invalidate = useInvalidateGroupWork()
  const m = useMutation({
    mutationFn: () =>
      api<ApplicationGroupRelease>(`${ENDPOINT}${a!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: (r) => {
      const detail = releaseSummary(r)
      toast.success(
        detail ? `Unassigned ${a!.group.name} · ${detail}` : `Unassigned`
      )
      invalidate()
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  const hostName = a?.device?.name ?? a?.virtual_machine?.name ?? ""
  return (
    <AlertDialog open={!!a} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Unassign {a?.group.name} from {hostName}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Its unedited installs are removed; edited ones stay.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Unassigning…" : "Unassign"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** Make a host's groups exactly ``groupIds`` - the device and VM forms. */
export function setHostGroups(host: GroupHost, groupIds: string[]) {
  return api<{ assigned: string[]; unassigned: string[] }>(`${ENDPOINT}set/`, {
    method: "POST",
    body: JSON.stringify({ ...hostPayload(host), group_ids: groupIds }),
  })
}

/** The device and VM forms' "Application groups" field: the host's groups
 * (none for a new one) as a draft, written by ``commit`` once the host
 * saved - so a new server gets its groups, and their installs, in one go. */
export function useHostGroupsDraft(host: GroupHost | null) {
  const { canDo } = useMe()
  const invalidate = useInvalidateGroupWork()
  const canSet =
    canDo("applicationgroupassignment", "add") &&
    canDo("applicationgroupassignment", "delete") &&
    canDo("installedsoftware", "add") &&
    canDo("installedsoftware", "delete")
  const current = useQuery({
    queryKey: ["application-group-assignments", host?.kind, host?.id],
    queryFn: () =>
      apiAll<ApplicationGroupAssignment>(`${ENDPOINT}?${hostParam(host!)}`),
    enabled: !!host && canSet,
  })
  const initial = useMemo(
    () => (current.data?.results ?? []).map((a) => a.group.id),
    [current.data]
  )
  const [draft, setDraft] = useState<string[] | null>(null)
  const ids = draft ?? initial
  const changed =
    draft !== null &&
    (draft.length !== initial.length || draft.some((g) => !initial.includes(g)))
  return {
    /** False when the caller may not assign and unassign: no field. */
    show: canSet,
    ids,
    setIds: setDraft,
    /** Write the draft to the saved host; a no-op when nothing changed. */
    commit: async (saved: GroupHost) => {
      if (!canSet || !changed) return
      await setHostGroups(saved, ids)
      invalidate()
    },
  }
}

/** The application groups multi-select. */
export function ApplicationGroupsField({
  value,
  onChange,
  error,
}: {
  value: string[]
  onChange: (ids: string[]) => void
  error?: string
}) {
  const options = useQuery({
    queryKey: ["application-groups-picker"],
    queryFn: () =>
      apiAll<ApplicationGroupMini>("/api/application-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  return (
    <Field label="Application groups" error={error}>
      <IdMultiSelect
        options={(options.data?.results ?? []).map((g) => ({
          id: g.id,
          name: g.name,
        }))}
        value={value}
        onChange={onChange}
        placeholder="Add group…"
        searchPlaceholder="Search groups…"
        emptyText="No application groups."
      />
    </Field>
  )
}
