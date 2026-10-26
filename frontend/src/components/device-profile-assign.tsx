import { useEffect, useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import type {
  DeviceProfileAssignment,
  DeviceProfileMini,
  DeviceProfilePreview,
  DeviceProfilePreviewItem,
  DeviceProfileRelease,
  DeviceProfileState,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { IdMultiSelect } from "@/components/cells/id-multi-select"
import { ColorBadge } from "@/components/cells/color-badge"
import { Badge } from "@/components/ui/badge"
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FormCombobox } from "@/components/forms"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"

// Device profiles on a device or VM: the form field, the Apply dialog with
// its preview, unassign and re-apply.

export type ProfileHost = { kind: "device" | "vm"; id: string }

export const PROFILES_ENDPOINT = "/api/device-profiles/"
export const ASSIGN_ENDPOINT = "/api/device-profile-assignments/"

export const profileHostParam = (h: ProfileHost) =>
  h.kind === "device" ? `device=${h.id}` : `virtual_machine=${h.id}`

export const profileHostPayload = (h: ProfileHost) =>
  h.kind === "device" ? { device_id: h.id } : { virtual_machine_id: h.id }

/** Everything assigning a profile can change: the host (its tags, custom
 * fields, platform), its software and groups, the profile's counts. */
export function useInvalidateProfileWork() {
  const qc = useQueryClient()
  return () => {
    for (const key of [
      "device-profile-assignments",
      "device-profiles",
      "device-profile",
      "devices",
      "device",
      "virtual-machines",
      "virtual-machine",
      "installed-software",
      "application-group-assignments",
      "application-groups",
      "lifecycle",
    ])
      qc.invalidateQueries({ queryKey: [key] })
  }
}

/** The profile catalog as options, coloured as their badges. */
export function useProfileOptions(enabled = true) {
  return useQuery({
    queryKey: ["device-profiles-picker"],
    queryFn: () => apiAll<DeviceProfileMini>(`${PROFILES_ENDPOINT}?picker=1`),
    staleTime: 10 * 60_000,
    enabled,
  })
}

const STATE: Record<
  DeviceProfileState,
  { label: string; variant: "success" | "warning" | "info" | "secondary" }
> = {
  ok: { label: "OK", variant: "success" },
  missing: { label: "Missing", variant: "warning" },
  edited: { label: "Edited", variant: "info" },
  pending: { label: "Pending", variant: "secondary" },
}

/** An assignment's state: in step, rows removed by hand, rows edited. */
export function ProfileStateBadge({ state }: { state: DeviceProfileState }) {
  const s = STATE[state]
  return <Badge variant={s.variant}>{s.label}</Badge>
}

export const profileStateLabel = (state: DeviceProfileState) =>
  STATE[state].label

/** A profile as its badge, linking to its page. */
export function ProfileBadge({
  profile,
}: {
  profile: { id: string; name: string; color: string }
}) {
  return (
    <Link
      to="/device-profiles/$id"
      params={{ id: profile.id }}
      className="inline-flex"
    >
      <ColorBadge name={profile.name} color={profile.color || undefined} />
    </Link>
  )
}

/** Toast line for what an unassign did with the profile's rows. */
export function profileReleaseSummary(r: DeviceProfileRelease): string {
  const parts: string[] = []
  if (r.removed) parts.push(`${r.removed} removed`)
  if (r.kept) parts.push(`${r.kept} kept`)
  if (r.moved) parts.push(`${r.moved} moved to another profile`)
  return parts.join(" · ")
}

const hostName = (a: DeviceProfileAssignment) =>
  a.device?.name ?? a.virtual_machine?.name ?? ""

/** Unassign one profile from one object. */
export function UnassignProfileDialog({
  assignment: a,
  onOpenChange,
}: {
  assignment: DeviceProfileAssignment | null
  onOpenChange: (open: boolean) => void
}) {
  const invalidate = useInvalidateProfileWork()
  const m = useMutation({
    mutationFn: () =>
      api<DeviceProfileRelease>(`${ASSIGN_ENDPOINT}${a!.id}/`, {
        method: "DELETE",
      }),
    onSuccess: (r) => {
      const detail = profileReleaseSummary(r)
      toast.success(
        detail
          ? `Unassigned ${a!.profile.name} · ${detail}`
          : `Unassigned ${a!.profile.name}`
      )
      invalidate()
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })
  return (
    <AlertDialog open={!!a} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Unassign {a?.profile.name} from {a ? hostName(a) : ""}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            What it wrote and nobody changed is removed; edited rows stay.
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

/** Re-apply: restore what an assignment wrote and someone removed. */
export function useReapplyProfile() {
  const invalidate = useInvalidateProfileWork()
  return useMutation({
    mutationFn: (a: DeviceProfileAssignment) =>
      api<{
        assignment: DeviceProfileAssignment
        created: { kind: string; label: string }[]
        changed: { kind: string; label: string }[]
      }>(`${ASSIGN_ENDPOINT}${a.id}/reapply/`, { method: "POST" }),
    onSuccess: (r) => {
      const n = r.created.length + r.changed.length
      toast.success(
        n
          ? `Re-applied ${r.assignment.profile.name} · ${n} restored`
          : `${r.assignment.profile.name} is in step`
      )
      invalidate()
    },
    onError: (err) => apiErrorToast(err),
  })
}

// ─── preview ─────────────────────────────────────────────────────────────

const GROUPS = [
  { key: "create", label: "Will create" },
  { key: "change", label: "Will change" },
  { key: "present", label: "Already there" },
  { key: "skip", label: "Skipped" },
] as const

function itemText(i: DeviceProfilePreviewItem): string {
  if (i.value === undefined || i.value === null) return i.label
  const v = Array.isArray(i.value) ? i.value.join(", ") : String(i.value)
  return `${i.label}: ${v}`
}

/** What assigning a profile would do, section by section. */
export function ProfilePreviewView({
  preview,
}: {
  preview: DeviceProfilePreview
}) {
  const sections = preview.sections.filter((s) =>
    GROUPS.some((g) => s[g.key].length > 0)
  )
  return (
    <div className="grid gap-3 text-sm">
      {preview.refused && (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
          {preview.refused}
        </p>
      )}
      {preview.missing_permissions.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive">
          <div className="font-medium">Missing permissions</div>
          <ul className="mt-1 list-disc pl-5">
            {preview.missing_permissions.map((m) => (
              <li key={`${m.type}:${m.action}`}>
                {m.action} {m.label.toLowerCase()}
              </li>
            ))}
          </ul>
        </div>
      )}
      {preview.already_assigned && (
        <p className="text-muted-foreground">Already assigned here.</p>
      )}
      {sections.length === 0 ? (
        <p className="text-muted-foreground">Nothing to write.</p>
      ) : (
        sections.map((s) => (
          <section
            key={s.kind}
            aria-label={s.label}
            className="rounded-lg border border-border"
          >
            <h3 className="border-b border-border px-3 py-1.5 text-[11px] font-semibold tracking-wide uppercase">
              {s.label}
            </h3>
            <div className="grid gap-2 px-3 py-2">
              {GROUPS.map((g) =>
                s[g.key].length === 0 ? null : (
                  <div key={g.key} className="grid gap-1">
                    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      {g.label}
                      <Badge
                        variant={g.key === "create" ? "success" : "secondary"}
                        className="num"
                      >
                        {s[g.key].length}
                      </Badge>
                    </div>
                    <ul className="grid gap-0.5">
                      {s[g.key].map((i) => (
                        <li key={i.key} className="flex flex-wrap gap-x-2">
                          <span>{itemText(i)}</span>
                          {i.reason && (
                            <span className="text-xs text-muted-foreground">
                              {i.reason}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )
              )}
            </div>
          </section>
        ))
      )}
    </div>
  )
}

/** Apply a profile to one device or VM: pick it, read the preview, confirm. */
export function ApplyProfileDialog({
  host,
  assignedIds,
  open,
  onOpenChange,
}: {
  host: ProfileHost
  /** Profiles already on the object, left out of the list. */
  assignedIds?: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const invalidate = useInvalidateProfileWork()
  const [profileId, setProfileId] = useState<string | null>(null)
  useEffect(() => {
    if (open) setProfileId(null)
  }, [open])
  const options = useProfileOptions(open)
  const taken = useMemo(() => new Set(assignedIds ?? []), [assignedIds])

  const preview = useQuery({
    queryKey: ["device-profile-preview", profileId, host.kind, host.id],
    queryFn: () =>
      api<DeviceProfilePreview>(`${PROFILES_ENDPOINT}${profileId}/preview/`, {
        method: "POST",
        body: JSON.stringify(profileHostPayload(host)),
      }),
    enabled: open && !!profileId,
    staleTime: 0,
  })
  const p = preview.data
  const blocked =
    !p || !!p.refused || p.already_assigned || p.missing_permissions.length > 0

  const save = useMutation({
    mutationFn: () =>
      api<{
        assignment: DeviceProfileAssignment
        created: { kind: string; label: string }[]
      }>(ASSIGN_ENDPOINT, {
        method: "POST",
        body: JSON.stringify({
          profile_id: profileId,
          ...profileHostPayload(host),
        }),
      }),
    onSuccess: (r) => {
      const n = r.created.length
      toast.success(
        `Applied ${r.assignment.profile.name} · ${n} ${n === 1 ? "item" : "items"} written`
      )
      invalidate()
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Apply profile</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!blocked) save.mutate()
          }}
          className="grid gap-4"
        >
          <FormCombobox
            label="Profile"
            required
            value={profileId}
            onChange={setProfileId}
            options={(options.data?.results ?? [])
              .filter((o) => !taken.has(o.id))
              .map((o) => ({
                value: o.id,
                label: o.name,
                color: o.color || null,
                badge: true,
              }))}
            placeholder="Pick a profile…"
            searchPlaceholder="Search profiles…"
            emptyText="No profiles."
          />
          {profileId &&
            (preview.isLoading ? (
              <Loading />
            ) : preview.isError ? (
              <QueryError error={preview.error} />
            ) : p ? (
              <ProfilePreviewView preview={p} />
            ) : null)}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={blocked || save.isPending}>
              {save.isPending ? "Applying…" : "Apply"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── form field ──────────────────────────────────────────────────────────

/** Make an object's profiles exactly ``profileIds``, in order. */
export function setHostProfiles(host: ProfileHost, profileIds: string[]) {
  return api<{ assigned: string[]; unassigned: string[] }>(
    `${ASSIGN_ENDPOINT}set/`,
    {
      method: "POST",
      body: JSON.stringify({
        ...profileHostPayload(host),
        profile_ids: profileIds,
      }),
    }
  )
}

/** The device and VM forms' "Profiles" field: the object's profiles (none
 * for a new one) as a draft, written by ``commit`` once the object saved. */
export function useHostProfilesDraft(host: ProfileHost | null) {
  const { canDo } = useMe()
  const invalidate = useInvalidateProfileWork()
  const canSet =
    canDo("deviceprofileassignment", "view") &&
    canDo("deviceprofileassignment", "add") &&
    canDo("deviceprofileassignment", "delete")
  const current = useQuery({
    queryKey: ["device-profile-assignments", host?.kind, host?.id],
    queryFn: () =>
      apiAll<DeviceProfileAssignment>(
        `${ASSIGN_ENDPOINT}?${profileHostParam(host!)}`
      ),
    enabled: !!host && canSet,
  })
  const initial = useMemo(
    () => (current.data?.results ?? []).map((a) => a.profile.id),
    [current.data]
  )
  const [draft, setDraft] = useState<string[] | null>(null)
  const ids = draft ?? initial
  const changed =
    draft !== null &&
    (draft.length !== initial.length || draft.some((p, i) => initial[i] !== p))
  return {
    /** False when the caller may not assign and unassign: no field. */
    show: canSet,
    ids,
    setIds: setDraft,
    /** Write the draft to the saved object; a no-op when nothing changed. */
    commit: async (saved: ProfileHost) => {
      if (!canSet || !changed) return
      await setHostProfiles(saved, ids)
      invalidate()
    },
  }
}

/** The profiles multi-select: ordered, the first wins a single value. */
export function DeviceProfilesField({
  value,
  onChange,
  error,
}: {
  value: string[]
  onChange: (ids: string[]) => void
  error?: string
}) {
  const options = useProfileOptions()
  return (
    <Field label="Profiles" error={error}>
      <IdMultiSelect
        ordered
        options={(options.data?.results ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          color: p.color || null,
        }))}
        value={value}
        onChange={onChange}
        placeholder="Add profile…"
        searchPlaceholder="Search profiles…"
        emptyText="No device profiles."
      />
    </Field>
  )
}
