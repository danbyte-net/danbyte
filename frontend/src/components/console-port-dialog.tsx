import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { ConsolePort, ConsolePortWritePayload } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  FormCombobox,
  FormFooter,
  FormText,
  useFieldErrors,
} from "@/components/forms"
import { useDcimChoices } from "@/lib/use-dcim-choices"

export type ConsolePortKind = "port" | "server-port"

const ENDPOINT: Record<ConsolePortKind, string> = {
  port: "console-ports",
  "server-port": "console-server-ports",
}
const QUERY_KEY: Record<ConsolePortKind, string> = {
  port: "device-console-ports",
  "server-port": "device-console-server-ports",
}
const NOUN: Record<ConsolePortKind, string> = {
  port: "console port",
  "server-port": "console server port",
}

export interface ConsolePortDialogProps {
  /** Console ports (RJ-45 on a device) vs console server ports (the far side). */
  kind: ConsolePortKind
  deviceId: string
  /** When set, the dialog edits this port instead of creating one. */
  port?: ConsolePort | null
  open: boolean
  onOpenChange: (open: boolean) => void
}

// Add/edit dialog shared by the two console tables — same fields, different
// endpoint.
export function ConsolePortDialog({
  kind,
  deviceId,
  port,
  open,
  onOpenChange,
}: ConsolePortDialogProps) {
  const isEdit = !!port
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const choices = useDcimChoices()

  const [name, setName] = useState("")
  const [type, setType] = useState("")
  const [speed, setSpeed] = useState("")
  const [description, setDescription] = useState("")

  // Fresh form every time the dialog opens (prefilled when editing).
  useEffect(() => {
    if (!open) return
    setName(port?.name ?? "")
    setType(port?.type ?? "")
    setSpeed(port?.speed != null ? String(port.speed) : "")
    setDescription(port?.description ?? "")
    reset()
  }, [open, port, reset])

  const mutation = useMutation({
    mutationFn: () => {
      const payload: ConsolePortWritePayload = {
        device_id: deviceId,
        name: name.trim(),
        type,
        speed: speed.trim() === "" ? null : Number(speed),
        description: description.trim(),
      }
      if (isEdit)
        return api<ConsolePort>(`/api/${ENDPOINT[kind]}/${port!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ConsolePort>(`/api/${ENDPOINT[kind]}/`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: [QUERY_KEY[kind], deviceId] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
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
          <DialogTitle>
            {isEdit ? `Edit ${NOUN[kind]}` : `Add ${NOUN[kind]}`}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <div className="grid grid-cols-2 gap-3">
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              mono
              placeholder="console0"
              error={fieldErrors.name}
            />
            <FormText
              label="Speed (baud)"
              type="number"
              value={speed}
              onChange={setSpeed}
              placeholder="115200"
              error={fieldErrors.speed}
            />
          </div>
          <FormCombobox
            label="Type"
            value={type || null}
            onChange={(v) => setType(v ?? "")}
            noneLabel="No type"
            placeholder="Pick a type"
            searchPlaceholder="Search types…"
            emptyText="No types."
            options={choices.console_port_types ?? []}
            error={fieldErrors.type}
          />
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
            placeholder="Optional"
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : `Create ${NOUN[kind]}`}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
