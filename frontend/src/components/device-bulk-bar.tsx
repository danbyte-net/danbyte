import { BulkExport } from "@/components/bulk-export"
import { useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { Rocket, X } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type AutomationTarget,
  type Device,
  type DeployRun,
  type Paginated,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { FormSelect } from "@/components/forms"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiErrorToast } from "@/lib/api-toast"

// Floating action bar for /devices — appears when rows are selected. Today it
// offers a single bulk action: deploy the selection to an automation target.
// Danbyte hands off to the runner; it never touches the devices directly.
export interface DeviceBulkBarProps {
  selected: Device[]
  onCleared: () => void
}

export function DeviceBulkBar({ selected, onCleared }: DeviceBulkBarProps) {
  const [open, setOpen] = useState(false)
  if (selected.length === 0) return null
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => setOpen(true)}
          >
            <Rocket className="mr-1 h-3 w-3" /> Deploy
          </Button>
          <BulkExport ioType="device" ids={selected.map((d) => d.id)} />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onCleared}
            title="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      <DeployDialog
        open={open}
        onOpenChange={setOpen}
        devices={selected}
        onDone={() => {
          setOpen(false)
          onCleared()
        }}
      />
    </>
  )
}

function DeployDialog({
  open,
  onOpenChange,
  devices,
  onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  devices: Device[]
  onDone: () => void
}) {
  const [targetId, setTargetId] = useState<string | null>(null)

  const targets = useQuery({
    queryKey: ["automation-targets", "enabled"],
    queryFn: () => api<Paginated<AutomationTarget>>("/api/automation-targets/"),
    staleTime: 60_000,
    enabled: open,
  })
  const options = (targets.data?.results ?? [])
    .filter((t) => t.enabled)
    .map((t) => ({ value: t.id, label: `${t.name} · ${t.kind_display}` }))

  const deploy = useMutation({
    mutationFn: () =>
      api<DeployRun>(`/api/automation-targets/${targetId}/deploy/`, {
        method: "POST",
        body: JSON.stringify({ device_ids: devices.map((d) => d.id) }),
      }),
    onSuccess: (run) => {
      if (run.status === "failed")
        toast.error(`Deploy failed: ${run.detail || "see run"}`)
      else
        toast.success(
          `Deploying ${run.device_ids.length} device${
            run.device_ids.length === 1 ? "" : "s"
          } (${run.status})`
        )
      onDone()
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Deploy {devices.length} devices</DialogTitle>
          <DialogDescription>
            Danbyte launches the runner, which holds the device credentials — it
            never connects to the devices directly.
          </DialogDescription>
        </DialogHeader>
        {options.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No enabled automation targets. Add one under Integrations →
            Automation targets.
          </p>
        ) : (
          <FormSelect
            label="Target"
            value={targetId}
            onChange={setTargetId}
            options={options}
            placeholder="Pick a target"
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!targetId || deploy.isPending}
            onClick={() => deploy.mutate()}
          >
            {deploy.isPending ? (
              <Spinner className="mr-1 size-4" />
            ) : (
              <Rocket className="mr-1 size-4" />
            )}
            Deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
