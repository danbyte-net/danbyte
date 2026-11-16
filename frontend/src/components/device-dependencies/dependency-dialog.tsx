import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { toast } from "sonner"

import { ApiError } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useSaveObject } from "@/lib/save-object"
import type {
  DependencyKind,
  DependencyMediumRef,
  DeviceDependency,
  DeviceDependencyWritePayload,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"

// Add or edit device dependencies (#450). From a device page the device is
// one end ("Add upstream": it is the downstream) and several devices can be
// picked for the other; from the list both ends are picked. An edit keeps
// the ends. The server refuses a cycle with its path, a pair that is
// already related and a self-reference; each refusal shows here.

export interface DeviceRef {
  id: string
  name: string
}

export type DependencyDialogMode =
  | {
      kind: "add"
      anchor?: { device: DeviceRef; as: "downstream" | "upstream" }
    }
  | { kind: "edit"; dependency: DeviceDependency }

const OBJECT_TYPE = "api.devicedependency"
const ENDPOINT = "/api/device-dependencies/"

const KIND_OPTIONS = [
  { value: "dependency", label: "Dependency" },
  { value: "peer", label: "Peer" },
]

/** Invalidated whenever a dependency changes. */
export const DEVICE_DEPENDENCY_KEYS = [
  ["device-dependencies"],
  ["device-dependency-tree"],
  ["device-impact"],
  ["dependency-media"],
]

/** The first message of a DRF 400 body, field errors before `detail`. */
export function apiErrorText(err: unknown): string {
  if (err instanceof ApiError && err.body && typeof err.body === "object") {
    for (const v of Object.values(err.body as Record<string, unknown>)) {
      const msg = Array.isArray(v) ? v[0] : v
      if (msg) return String(msg)
    }
  }
  return err instanceof Error ? err.message : "Couldn't save."
}

export function DeviceDependencyDialog({
  mode,
  open,
  onOpenChange,
  onSaved,
}: {
  mode: DependencyDialogMode
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: () => void
}) {
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const editing = mode.kind === "edit" ? mode.dependency : null
  const anchor = mode.kind === "add" ? mode.anchor : undefined
  const [upstreamId, setUpstreamId] = useState<string | null>(null)
  const [downstreamId, setDownstreamId] = useState<string | null>(null)
  const [picked, setPicked] = useState<DeviceRef[]>([])
  const [kind, setKind] = useState<DependencyKind>("dependency")
  const [mediumId, setMediumId] = useState<string | null>(null)
  const [group, setGroup] = useState("")
  const [description, setDescription] = useState("")
  /** Per-device refusals of a multi-device add: "acc-7: This would make…". */
  const [refusals, setRefusals] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    setUpstreamId(null)
    setDownstreamId(null)
    setPicked([])
    setKind(editing?.kind ?? "dependency")
    setMediumId(editing?.medium?.id ?? null)
    setGroup(editing?.redundancy_group ?? "")
    setDescription(editing?.description ?? "")
    setRefusals([])
    reset()
  }, [open, editing, reset])

  const media = useQuery({
    queryKey: ["dependency-media-picker"],
    queryFn: () =>
      apiAll<DependencyMediumRef>("/api/dependency-media/?picker=1"),
    enabled: open,
  })
  const mediumOptions = useMemo(
    () =>
      (media.data?.results ?? []).map((m) => ({
        value: m.id,
        label: m.name,
        color: m.color || null,
        badge: true,
        icon: m.icon || null,
      })),
    [media.data]
  )

  const common = (): DeviceDependencyWritePayload => ({
    kind,
    medium_id: mediumId,
    redundancy_group: kind === "peer" ? "" : group.trim(),
    description: description.trim(),
  })

  const save = useMutation({
    mutationFn: async () => {
      if (editing) {
        await saveObject<DeviceDependency>({
          objectType: OBJECT_TYPE,
          endpoint: ENDPOINT,
          id: editing.id,
          payload: common(),
        })
        return { saved: 1, failed: [] as string[], left: [] as DeviceRef[] }
      }
      if (!anchor) {
        await saveObject<DeviceDependency>({
          objectType: OBJECT_TYPE,
          endpoint: ENDPOINT,
          payload: {
            ...common(),
            upstream_id: upstreamId ?? undefined,
            downstream_id: downstreamId ?? undefined,
          },
        })
        return { saved: 1, failed: [] as string[], left: [] as DeviceRef[] }
      }
      if (picked.length === 0) {
        throw new ApiError(400, {
          other: [
            anchor.as === "downstream"
              ? "Pick at least one upstream device."
              : "Pick at least one dependent device.",
          ],
        })
      }
      const failed: string[] = []
      const left: DeviceRef[] = []
      let saved = 0
      for (const other of picked) {
        const ends =
          anchor.as === "downstream"
            ? { upstream_id: other.id, downstream_id: anchor.device.id }
            : { upstream_id: anchor.device.id, downstream_id: other.id }
        try {
          await saveObject<DeviceDependency>({
            objectType: OBJECT_TYPE,
            endpoint: ENDPOINT,
            payload: { ...common(), ...ends },
          })
          saved += 1
        } catch (err) {
          // One device alone keeps the server's own field error.
          if (picked.length === 1) throw err
          failed.push(`${other.name}: ${apiErrorText(err)}`)
          left.push(other)
        }
      }
      return { saved, failed, left }
    },
    onSuccess: ({ saved, failed, left }) => {
      for (const queryKey of DEVICE_DEPENDENCY_KEYS)
        qc.invalidateQueries({ queryKey })
      if (saved) {
        toast.success(
          editing
            ? "Updated the dependency"
            : saved === 1
              ? "Added a dependency"
              : `Added ${saved} dependencies`
        )
        onSaved?.()
      }
      if (failed.length) {
        setRefusals(failed)
        setPicked(left)
        return
      }
      onOpenChange(false)
    },
    onError: (err) => {
      setRefusals([])
      handleApiError(err)
    },
  })

  const otherLabel =
    anchor?.as === "downstream" ? "Upstream devices" : "Dependent devices"
  // Errors on an end the dialog does not offer go to the picker it does.
  const endError = anchor
    ? fieldErrors.other ||
      (anchor.as === "downstream"
        ? fieldErrors.upstream_id || fieldErrors.downstream_id
        : fieldErrors.downstream_id || fieldErrors.upstream_id)
    : undefined
  const title = editing
    ? "Edit dependency"
    : anchor?.as === "downstream"
      ? `Add upstream of ${anchor.device.name}`
      : anchor
        ? `Add dependents of ${anchor.device.name}`
        : "Add dependency"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            save.mutate()
          }}
          className="grid gap-4"
        >
          {editing ? (
            <Field label="Devices">
              <p className="text-[13px]">
                {editing.downstream?.name ?? "Hidden"}
                <span className="text-muted-foreground">
                  {editing.kind === "peer" ? " ↔ " : " depends on "}
                </span>
                {editing.upstream?.name ?? "Hidden"}
              </p>
            </Field>
          ) : anchor ? (
            <div className="grid gap-2">
              <DevicePicker
                label={otherLabel}
                required
                value={null}
                onChange={() => {}}
                onPickMany={(items) =>
                  setPicked((cur) => [
                    ...cur,
                    ...items
                      .filter(
                        (i) =>
                          i.id !== anchor.device.id &&
                          !cur.some((c) => c.id === i.id)
                      )
                      .map((i) => ({ id: i.id, name: i.label })),
                  ])
                }
                excludeIds={[anchor.device.id, ...picked.map((p) => p.id)]}
                error={endError}
              />
              {picked.length > 0 && (
                <ul className="flex flex-wrap gap-1.5" aria-label="Picked">
                  {picked.map((p) => (
                    <li
                      key={p.id}
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 py-0.5 pr-1 pl-2 text-[12px]"
                    >
                      {p.name}
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-5"
                        aria-label={`Remove ${p.name}`}
                        onClick={() =>
                          setPicked((cur) => cur.filter((c) => c.id !== p.id))
                        }
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <DevicePicker
                label="Downstream"
                required
                value={downstreamId}
                onChange={setDownstreamId}
                error={fieldErrors.downstream_id}
              />
              <DevicePicker
                label="Upstream"
                required
                value={upstreamId}
                onChange={setUpstreamId}
                error={fieldErrors.upstream_id}
              />
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <FormSelect
              label="Kind"
              value={kind}
              onChange={(v) => setKind(v as DependencyKind)}
              options={KIND_OPTIONS}
              info="A peer links two equal devices; impact and root cause ignore it."
              error={fieldErrors.kind}
            />
            <FormCombobox
              label="Medium"
              value={mediumId}
              onChange={setMediumId}
              options={mediumOptions}
              noneLabel="No medium"
              error={fieldErrors.medium_id}
            />
          </div>
          <FormText
            label="Redundancy group"
            value={kind === "peer" ? "" : group}
            onChange={setGroup}
            disabled={kind === "peer"}
            placeholder="uplinks"
            info="Upstreams of one device that share a group back each other: it is down only when all of them are."
            error={fieldErrors.redundancy_group}
          />
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          {refusals.length > 0 && (
            <ul
              role="alert"
              className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-[12px] text-destructive"
            >
              {refusals.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          )}
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={editing ? "Save changes" : "Add"}
            submittingLabel={editing ? "Saving…" : "Adding…"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
