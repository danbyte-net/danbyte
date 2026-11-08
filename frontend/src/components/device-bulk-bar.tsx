import { BulkExport } from "@/components/bulk-export"
import { AddToSlaButton } from "@/components/monitoring/sla-add"
import { useState } from "react"
import { Rocket, Trash2, X } from "lucide-react"

import { api } from "@/lib/api"
import { DeployDialog as SharedDeployDialog } from "@/components/deploy-dialog"
import type { DeployResult } from "@/components/deploy-dialog"
import type { Device } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { PrintLabelButton } from "@/components/print-label-button"
import { SafeBulkDeleteDialog } from "@/components/safe-bulk-delete-bar"
import { ApplyProfileBulkButton } from "@/components/device-profile-bulk"
import { reportExport, useObjectReport } from "@/components/object-report"

// Floating action bar for /devices - appears when rows are selected: deploy
// the selection to an automation target (Danbyte hands off to the runner; it
// never touches the devices directly), apply a device profile, labels,
// export, SLA and delete.
export interface DeviceBulkBarProps {
  selected: Device[]
  onCleared: () => void
  /** Offer Deploy (default true). */
  canDeploy?: boolean
  /** Offer Delete, with "Also remove from PRTG" (default false). */
  canDelete?: boolean
  /** Offer Apply profile. */
  profiles?: boolean
}

export function DeviceBulkBar({
  selected,
  onCleared,
  canDeploy = true,
  canDelete = false,
  profiles = false,
}: DeviceBulkBarProps) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const report = useObjectReport("device")
  if (selected.length === 0) return null
  const ids = selected.map((d) => d.id)
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          {canDeploy && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setOpen(true)}
            >
              <Rocket className="mr-1 h-3 w-3" /> Deploy
            </Button>
          )}
          {profiles && (
            <ApplyProfileBulkButton
              kind="device"
              ids={selected.map((d) => d.id)}
              onDone={onCleared}
            />
          )}
          <PrintLabelButton
            objectType="device"
            ids={selected.map((d) => d.id)}
            label={`Print labels (${selected.length})`}
            variant="ghost"
          />
          <BulkExport
            ioType="device"
            ids={ids}
            extraExports={[
              reportExport(report.openReport, () => ({
                ids,
                scope: "selected",
              })),
            ]}
          />
          <AddToSlaButton
            objectType="api.device"
            ids={selected.map((d) => d.id)}
          />
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive hover:text-destructive"
              onClick={() => setDeleting(true)}
            >
              <Trash2 className="mr-1 h-3 w-3" /> Delete
            </Button>
          )}
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
      {report.dialog}
      {deleting && (
        <SafeBulkDeleteDialog
          ids={selected.map((d) => d.id)}
          endpoint="/api/devices/"
          noun={["device", "devices"]}
          invalidate={[["devices"], ["devices-picker"], ["prtg-links"]]}
          prtg
          onClose={() => setDeleting(false)}
          onDone={onCleared}
        />
      )}
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
  const ids = devices.map((d) => d.id)
  // A shared role makes its default pipeline the preselected one.
  const roles = new Set(devices.map((d) => d.role?.id ?? ""))
  const roleIds = roles.size === 1 ? [...roles] : []
  return (
    <SharedDeployDialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Deploy ${devices.length} devices`}
      description="Danbyte launches the runner, which holds the device credentials - it never connects to the devices directly."
      objectType="device"
      roleIds={roleIds}
      submit={(c) =>
        api<DeployResult>(
          c.kind === "pipeline"
            ? `/api/deploy-pipelines/${c.id}/deploy/`
            : `/api/automation-targets/${c.id}/deploy/`,
          {
            method: "POST",
            body: JSON.stringify({ device_ids: ids, dry_run: c.dryRun }),
          }
        ).then((r) =>
          c.kind === "pipeline"
            ? ({ ...r, kind: "pipeline" } as DeployResult)
            : r
        )
      }
      onDone={onDone}
    />
  )
}
