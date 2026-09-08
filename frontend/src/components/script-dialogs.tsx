import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Script, ScriptParam, ScriptRun } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
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
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field } from "@/components/forms/field"
import { FormCheckbox } from "@/components/forms/checkbox"
import { FormSelect } from "@/components/forms/select"
import { FormText } from "@/components/forms/text"
import { FormTextarea } from "@/components/forms/textarea"

const STARTER = `"""What this script does."""
from danbyte_sdk import db, run

devices = db.list("devices")
run.log(f"{len(devices)} device(s)")
run.output_csv("devices.csv", devices, fields=["name", "site_name", "status"])
`

/** New script: just a name, then straight to the editor. */
export function ScriptCreateDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState("")
  const [description, setDescription] = useState("")

  const create = useMutation({
    mutationFn: () =>
      api<Script>("/api/scripts/", {
        method: "POST",
        body: JSON.stringify({ name, description, source: STARTER }),
      }),
    onSuccess: (s) => {
      void qc.invalidateQueries({ queryKey: ["scripts"] })
      onClose()
      void navigate({ to: "/scripts/$id", params: { id: s.id } })
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New script</DialogTitle>
          <DialogDescription>
            It starts private to you and runs with your own access.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <FormText
            label="Name"
            value={name}
            onChange={setName}
            required
            autoFocus
          />
          <FormText
            label="Description"
            value={description}
            onChange={setDescription}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => create.mutate()}
            disabled={create.isPending || !name.trim()}
          >
            {create.isPending ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ScriptDeleteDialog({
  item,
  onOpenChange,
}: {
  item: Script | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: (s: Script) =>
      api(`/api/scripts/${s.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Script deleted")
      void qc.invalidateQueries({ queryKey: ["scripts"] })
      onOpenChange(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <AlertDialog open={item !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {item?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its runs and their output files go with it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={() => item && remove.mutate(item)}>
            {remove.isPending ? "Deleting..." : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** One input per declared parameter - the same switch the custom-field form
 * uses, so a script's Run dialog looks like every other form. */
function ParamInput({
  spec,
  value,
  onChange,
}: {
  spec: ScriptParam
  value: unknown
  onChange: (v: unknown) => void
}) {
  const label = spec.label + (spec.required ? " *" : "")
  if (spec.type === "boolean")
    return (
      <FormCheckbox
        label={label}
        hint={spec.help}
        checked={Boolean(value)}
        onChange={onChange}
      />
    )
  if (spec.type === "choice")
    return (
      <FormSelect
        label={label}
        hint={spec.help}
        value={value == null ? null : String(value)}
        onChange={onChange}
        options={spec.choices.map((c) => ({ value: c, label: c }))}
      />
    )
  if (spec.type === "text")
    return (
      <FormTextarea
        label={label}
        hint={spec.help}
        rows={4}
        value={value == null ? "" : String(value)}
        onChange={onChange}
      />
    )
  return (
    <FormText
      label={label}
      hint={spec.help}
      type={
        spec.type === "integer" || spec.type === "decimal" ? "number" : "text"
      }
      value={value == null ? "" : String(value)}
      onChange={onChange}
    />
  )
}

export function ScriptRunDialog({
  script,
  onClose,
}: {
  script: Script
  onClose: () => void
}) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(
      script.params_schema.map((p) => [p.name, p.default ?? ""])
    )
  )
  const [errors, setErrors] = useState<Record<string, string[] | undefined>>({})

  const start = useMutation({
    mutationFn: () =>
      api<ScriptRun>(`/api/scripts/${script.id}/run/`, {
        method: "POST",
        body: JSON.stringify({ params: values }),
      }),
    onSuccess: (run) => {
      void qc.invalidateQueries({ queryKey: ["scripts"] })
      onClose()
      void navigate({ to: "/scripts/runs/$runId", params: { runId: run.id } })
    },
    onError: (e) => {
      const body = (e as { body?: Record<string, string[]> }).body
      if (body && typeof body === "object" && !("detail" in body))
        setErrors(body)
      else apiErrorToast(e)
    },
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run {script.name}</DialogTitle>
          <DialogDescription>
            Runs as {script.run_as === "owner" ? script.owner_name : "you"},
            with that account's access.
          </DialogDescription>
        </DialogHeader>
        {script.params_schema.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            This script takes no parameters.
          </p>
        ) : (
          <div className="space-y-3">
            {script.params_schema.map((spec) => (
              <Field key={spec.name} label="" error={errors[spec.name]?.[0]}>
                <ParamInput
                  spec={spec}
                  value={values[spec.name]}
                  onChange={(v) => setValues({ ...values, [spec.name]: v })}
                />
              </Field>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? "Starting..." : "Run"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
