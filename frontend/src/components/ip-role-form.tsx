import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { IPRole, IPRoleWritePayload } from "@/lib/api"
import {
  FormCheckbox,
  FormColor,
  FormFooter,
  FormIcon,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface IpRoleFormProps {
  role?: IPRole
  onSaved: (r: IPRole) => void
  onCancel: () => void
}

export function IpRoleForm({ role, onSaved, onCancel }: IpRoleFormProps) {
  const isEdit = !!role
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(role?.name ?? "")
  const [color, setColor] = useState(role?.color ?? "")
  const [description, setDescription] = useState(role?.description ?? "")
  const [weight, setWeight] = useState(role ? String(role.weight) : "100")
  const [icon, setIcon] = useState(role?.icon ?? "")
  const [isGateway, setIsGateway] = useState(role?.is_gateway ?? false)
  const [isVirtual, setIsVirtual] = useState(role?.is_virtual ?? false)

  useEffect(() => {
    if (!role) return
    setName(role.name)
    setColor(role.color)
    setDescription(role.description)
    setWeight(String(role.weight))
    setIcon(role.icon)
    setIsGateway(role.is_gateway)
    setIsVirtual(role.is_virtual)
    reset()
  }, [role, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: IPRoleWritePayload = {
        name: name.trim(),
        color: color || "",
        description: description.trim(),
        weight: weight.trim() === "" ? 100 : Number(weight),
        icon: icon.trim(),
        is_gateway: isGateway,
        is_virtual: isVirtual,
      }
      return saveObject<IPRole>({
        objectType: "api.iprole",
        endpoint: "/api/ip-roles/",
        id: isEdit ? role!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["ip-roles"] })
      qc.invalidateQueries({ queryKey: ["ip-roles-picker"] })
      qc.invalidateQueries({ queryKey: ["ip-role", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
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
      className="@container grid gap-4"
    >
      <FormSection title="IP role" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Gateway"
          error={fieldErrors.name}
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormText
          label="Weight"
          type="number"
          value={weight}
          onChange={setWeight}
          hint="Lower sorts first"
          error={fieldErrors.weight}
        />
        <FormCheckbox
          label="Gateway role"
          hint="Drives prefix gateway autospawn (one per tenant)"
          checked={isGateway}
          onChange={setIsGateway}
        />
        <FormCheckbox
          label="Virtual / shared"
          hint="VIP, HSRP/VRRP, anycast"
          checked={isVirtual}
          onChange={setIsVirtual}
        />
      </FormSection>

      <FormSection title="Appearance" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormColor
            label="Color"
            value={color}
            onChange={setColor}
            error={fieldErrors.color}
          />
          <FormIcon
            label="Icon"
            value={icon}
            onChange={setIcon}
            hint="shown on the role's badge"
            error={fieldErrors.icon}
          />
        </div>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create role"}
      />
    </form>
  )
}
