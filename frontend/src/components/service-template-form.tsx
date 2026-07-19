import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ServiceProtocol,
  type ServiceTemplate,
  type ServiceTemplateWritePayload,
} from "@/lib/api"
import {
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { parsePorts } from "@/components/services-pane"

// Sentinel thrown to abort the mutation on client-side validation failure so
// onError can skip the generic toast (the field error is already surfaced).
const CLIENT_INVALID = "client-validation"

export interface ServiceTemplateFormProps {
  template?: ServiceTemplate
  onSaved: (t: ServiceTemplate) => void
  onCancel: () => void
}

export function ServiceTemplateForm({
  template,
  onSaved,
  onCancel,
}: ServiceTemplateFormProps) {
  const isEdit = !!template
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(template?.name ?? "")
  const [protocol, setProtocol] = useState<ServiceProtocol>(
    template?.protocol ?? "tcp"
  )
  const [portsText, setPortsText] = useState(template?.ports.join(", ") ?? "")
  const [description, setDescription] = useState(template?.description ?? "")
  const [portsError, setPortsError] = useState<string | null>(null)

  useEffect(() => {
    if (!template) return
    setName(template.name)
    setProtocol(template.protocol)
    setPortsText(template.ports.join(", "))
    setDescription(template.description)
    setPortsError(null)
    reset()
  }, [template, reset])

  const mutation = useMutation({
    mutationFn: () => {
      // parsePorts silently drops non-integer / out-of-range tokens, so
      // re-tokenize the raw input here and surface anything that would vanish
      // instead of quietly submitting a shorter list.
      const tokens = portsText.split(/[,\s]+/).filter((t) => t !== "")
      const invalid = tokens.filter((t) => {
        const n = Number(t)
        return !Number.isInteger(n) || n < 1 || n > 65535
      })
      const ports = parsePorts(portsText)
      if (invalid.length > 0) {
        setPortsError(`Not a valid port (1–65535): ${invalid.join(", ")}`)
        throw new Error(CLIENT_INVALID)
      }
      if (ports.length === 0) {
        setPortsError("Enter at least one port between 1 and 65535.")
        throw new Error(CLIENT_INVALID)
      }
      setPortsError(null)
      const payload: ServiceTemplateWritePayload = {
        name: name.trim(),
        protocol,
        ports,
        description: description.trim(),
      }
      if (isEdit)
        return api<ServiceTemplate>(`/api/service-templates/${template!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ServiceTemplate>("/api/service-templates/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["service-templates"] })
      qc.invalidateQueries({ queryKey: ["service-template", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      if ((err as Error).message === CLIENT_INVALID) return
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        placeholder="HTTPS"
        error={fieldErrors.name}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Protocol"
          value={protocol}
          onChange={(v) => setProtocol((v as ServiceProtocol) ?? "tcp")}
          options={[
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
          ]}
          error={fieldErrors.protocol}
        />
        <FormText
          label="Ports"
          value={portsText}
          onChange={(v) => {
            setPortsText(v)
            setPortsError(null)
          }}
          mono
          placeholder="443, 8443"
          hint="comma-separated"
          error={portsError ?? fieldErrors.ports}
        />
      </div>
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create template"}
      />
    </form>
  )
}
