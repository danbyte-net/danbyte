import { useEffect, useState } from "react"

import type { FloorPlanTrayWritePayload } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { ColorPicker } from "@/components/ui/color-picker"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Field } from "@/components/forms"

/** Name a freshly-drawn tray, then create it. */
export function TrayNameDialog({
  points,
  onCancel,
  onCreate,
}: {
  points: [number, number][] | null
  onCancel: () => void
  onCreate: (payload: FloorPlanTrayWritePayload) => void
}) {
  const [name, setName] = useState("")
  const [kind, setKind] = useState("")
  const [color, setColor] = useState("#71717a")

  useEffect(() => {
    if (points) {
      setName("")
      setKind("")
      setColor("#71717a")
    }
  }, [points])

  return (
    <Dialog open={points !== null} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Name this tray</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            if (!name.trim() || !points) return
            onCreate({ name: name.trim(), kind, color, points })
          }}
        >
          <Field label="Name" hint="What the builder sees">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Tray A · North corridor"
              className="h-9"
            />
          </Field>
          <Field label="Kind" hint="tray, conduit, ladder…">
            <Input
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              placeholder="Optional"
              className="h-9"
            />
          </Field>
          <Field label="Color">
            <ColorPicker value={color} onChange={setColor} allowEmpty={false} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim()}>
              Create tray
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
