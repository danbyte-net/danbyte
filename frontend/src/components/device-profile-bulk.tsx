import { useEffect, useState } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation } from "@tanstack/react-query"
import { Layers3 } from "lucide-react"

import { api } from "@/lib/api"
import type {
  DeviceProfileBulkOutcome,
  DeviceProfileBulkResult,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
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
                      {r.name}
                    </Link>
                  ) : (
                    <Link
                      to="/virtual-machines/$id"
                      params={{ id: r.id }}
                      className="link"
                    >
                      {r.name}
                    </Link>
                  )}
                  <Badge variant={OUTCOME[r.outcome].variant}>
                    {OUTCOME[r.outcome].label}
                  </Badge>
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
