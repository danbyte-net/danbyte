import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  type ServiceTemplate,
  type ServiceTemplateWritePayload,
} from "@/lib/api"
import {
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"
import {
  EMPTY_SERVICE_PORTS,
  parseServicePorts,
  ServicePortsField,
  servicePortsFromApi,
  type ServicePortsValue,
} from "@/components/service-ports-field"

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
  const saveObject = useSaveObject()

  const [name, setName] = useState(template?.name ?? "")
  const [ports, setPorts] = useState<ServicePortsValue>(
    template
      ? servicePortsFromApi(
          template.protocol_ports,
          template.protocol,
          template.ports
        )
      : EMPTY_SERVICE_PORTS
  )
  const [description, setDescription] = useState(template?.description ?? "")
  const [portErrors, setPortErrors] = useState<{
    tcp: string | null
    udp: string | null
  }>({ tcp: null, udp: null })

  useEffect(() => {
    if (!template) return
    setName(template.name)
    setPorts(
      servicePortsFromApi(
        template.protocol_ports,
        template.protocol,
        template.ports
      )
    )
    setDescription(template.description)
    setPortErrors({ tcp: null, udp: null })
    reset()
  }, [template, reset])

  const mutation = useMutation({
    mutationFn: () => {
      // A bad token is reported rather than silently dropped, so a typo can't
      // submit a shorter port list than the one on screen.
      const parsed = parseServicePorts(ports)
      setPortErrors({ tcp: parsed.errors.tcp, udp: parsed.errors.udp })
      if (parsed.errors.tcp || parsed.errors.udp || parsed.errors.form) {
        if (parsed.errors.form)
          setPortErrors({ tcp: parsed.errors.form, udp: null })
        throw new Error(CLIENT_INVALID)
      }
      const payload: ServiceTemplateWritePayload = {
        name: name.trim(),
        protocol: parsed.protocol,
        ports: parsed.ports,
        protocol_ports: parsed.protocol_ports,
        description: description.trim(),
      }
      return saveObject<ServiceTemplate>({
        objectType: "api.servicetemplate",
        endpoint: "/api/service-templates/",
        id: isEdit ? template!.id : undefined,
        payload,
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
      <ServicePortsField
        value={ports}
        onChange={(v) => {
          setPorts(v)
          setPortErrors({ tcp: null, udp: null })
        }}
        errors={{
          tcp: portErrors.tcp ?? fieldErrors.ports ?? fieldErrors.protocol_ports,
          udp: portErrors.udp,
        }}
      />
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
