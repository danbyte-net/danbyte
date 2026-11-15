import type { TerminationKind } from "@/lib/api"
import { CableForm } from "@/components/cable-form"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** The port a cable starts from. */
export interface ConnectFrom {
  id: string
  kind: TerminationKind
  name: string
}

/**
 * The cable maker in place, with `from` already on side A - opened from a
 * free port's marker on the photo faceplate or the 3D model viewer, so a
 * cable is made without leaving the device. Keyed by the port: CableForm
 * seeds its A side at mount only.
 */
export function ConnectCableDialog({
  from,
  deviceName,
  onClose,
}: {
  from: ConnectFrom | null
  /** For the title. */
  deviceName?: string
  onClose: () => void
}) {
  return (
    <Dialog open={!!from} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="2xl" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            Connect a cable from {deviceName ? `${deviceName}:` : ""}
            {from?.name}
          </DialogTitle>
        </DialogHeader>
        {from && (
          <CableForm
            key={from.id}
            initialA={[{ kind: from.kind, id: from.id }]}
            onSaved={onClose}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
