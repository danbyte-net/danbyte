import type { ReactNode } from "react"
import type { UseMutationResult } from "@tanstack/react-query"

import type { FloorPlan, FloorPlanTrayWritePayload } from "@/lib/api"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { FloorPlanForm } from "@/components/floor-plan-form"
import { LeaveGuardDialog } from "@/components/leave-guard-dialog"
import type { LeaveBlocker } from "@/components/leave-guard-dialog"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

import { DeepViewSheet } from "./deep-view-sheet"
import { TrayNameDialog } from "./tray-name-dialog"
import type { CadDrawingState } from "./use-cad-drawing"
import type { PlanEditState } from "./use-plan-edit-state"

/** The editor's dialogs and sheets: name a new tray, a tile's deep view,
 * replace the drawing with an image, background and plan settings on a
 * narrow screen, and the unsaved-edit leave guard. */
export function PlanDialogs({
  plan,
  ed,
  cad,
  uploadBackground,
  createTray,
  traceCablesOnMap,
  backgroundControls,
  leaveGuard,
}: {
  plan: FloorPlan
  ed: PlanEditState
  cad: CadDrawingState
  uploadBackground: UseMutationResult<FloorPlan, Error, File | null>
  createTray: UseMutationResult<unknown, Error, FloorPlanTrayWritePayload>
  traceCablesOnMap: (cableIds: string[]) => void
  backgroundControls: ReactNode
  leaveGuard: LeaveBlocker
}) {
  const {
    namingPoints,
    setNamingPoints,
    deepTile,
    setDeepTile,
    pendingImage,
    setPendingImage,
    backgroundOpen,
    setBackgroundOpen,
    settingsOpen,
    setSettingsOpen,
  } = ed
  return (
    <>
      <TrayNameDialog
        points={namingPoints}
        onCancel={() => setNamingPoints(null)}
        onCreate={(payload) => {
          createTray.mutate(payload)
          setNamingPoints(null)
        }}
      />

      <DeepViewSheet
        tile={deepTile}
        onClose={() => setDeepTile(null)}
        onTraceCables={traceCablesOnMap}
      />

      <ConfirmDialog
        open={!!pendingImage}
        onOpenChange={(o) => !o && setPendingImage(null)}
        title="Replace the drawing?"
        description="A plan has one background. The image replaces the drawing and its layers."
        confirmLabel="Replace"
        pendingLabel="Uploading…"
        pending={uploadBackground.isPending || cad.remove.isPending}
        onConfirm={() => {
          if (!pendingImage) return
          uploadBackground.mutate(pendingImage, {
            onSuccess: () =>
              cad.remove.mutate(undefined, {
                onSettled: () => setPendingImage(null),
              }),
            onError: () => setPendingImage(null),
          })
        }}
      />

      <Dialog open={backgroundOpen} onOpenChange={setBackgroundOpen}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Background</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">{backgroundControls}</div>
        </DialogContent>
      </Dialog>

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent size="xl">
          <DialogHeader>
            <DialogTitle>Floor plan settings</DialogTitle>
          </DialogHeader>
          <FloorPlanForm
            plan={plan}
            onSaved={() => setSettingsOpen(false)}
            onCancel={() => setSettingsOpen(false)}
          />
        </DialogContent>
      </Dialog>

      {/* The leave guard's one dialog - for a floor switch, a sidebar link, and
          browser back alike. */}
      <LeaveGuardDialog
        blocker={leaveGuard}
        description="This plan has unsaved changes."
      />
    </>
  )
}
