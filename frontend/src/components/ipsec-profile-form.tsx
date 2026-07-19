import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type IkeVersion,
  type IPSecAuth,
  type IPSecEncryption,
  type IPSecProfile,
  type IPSecProfileWritePayload,
} from "@/lib/api"
import {
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

const IKE_VERSIONS: { value: string; label: string }[] = [
  { value: "2", label: "IKEv2" },
  { value: "1", label: "IKEv1" },
]
const ENCRYPTIONS: { value: IPSecEncryption; label: string }[] = [
  { value: "aes-256-gcm", label: "AES-256-GCM" },
  { value: "aes-128-gcm", label: "AES-128-GCM" },
  { value: "aes-256-cbc", label: "AES-256-CBC" },
  { value: "aes-192-cbc", label: "AES-192-CBC" },
  { value: "aes-128-cbc", label: "AES-128-CBC" },
  { value: "3des-cbc", label: "3DES-CBC" },
]
const AUTHS: { value: IPSecAuth; label: string }[] = [
  { value: "hmac-sha256", label: "HMAC-SHA256" },
  { value: "hmac-sha384", label: "HMAC-SHA384" },
  { value: "hmac-sha512", label: "HMAC-SHA512" },
  { value: "hmac-sha1", label: "HMAC-SHA1" },
  { value: "hmac-md5", label: "HMAC-MD5" },
]

export interface IPSecProfileFormProps {
  item?: IPSecProfile
  onSaved: (v: IPSecProfile) => void
  onCancel: () => void
}

export function IPSecProfileForm({
  item,
  onSaved,
  onCancel,
}: IPSecProfileFormProps) {
  const isEdit = !!item
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(item?.name ?? "")
  const [ikeVersion, setIkeVersion] = useState<IkeVersion>(
    item?.ike_version ?? 2
  )
  const [encryption, setEncryption] = useState<IPSecEncryption>(
    item?.encryption ?? "aes-256-cbc"
  )
  const [authentication, setAuthentication] = useState<IPSecAuth>(
    item?.authentication ?? "hmac-sha256"
  )
  const [dhGroup, setDhGroup] = useState(
    item?.dh_group != null ? String(item.dh_group) : "14"
  )
  const [pfsGroup, setPfsGroup] = useState(
    item?.pfs_group != null ? String(item.pfs_group) : ""
  )
  const [saLifetime, setSaLifetime] = useState(
    item?.sa_lifetime != null ? String(item.sa_lifetime) : ""
  )
  const [description, setDescription] = useState(item?.description ?? "")

  useEffect(() => {
    if (!item) return
    setName(item.name)
    setIkeVersion(item.ike_version)
    setEncryption(item.encryption)
    setAuthentication(item.authentication)
    setDhGroup(String(item.dh_group))
    setPfsGroup(item.pfs_group != null ? String(item.pfs_group) : "")
    setSaLifetime(item.sa_lifetime != null ? String(item.sa_lifetime) : "")
    setDescription(item.description)
    reset()
  }, [item, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: IPSecProfileWritePayload = {
        name: name.trim(),
        ike_version: ikeVersion,
        encryption,
        authentication,
        dh_group: dhGroup ? Number(dhGroup) : 14,
        pfs_group: pfsGroup ? Number(pfsGroup) : null,
        sa_lifetime: saLifetime ? Number(saLifetime) : null,
        description: description.trim(),
      }
      if (isEdit)
        return api<IPSecProfile>(`/api/ipsec-profiles/${item!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<IPSecProfile>("/api/ipsec-profiles/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["ipsec-profiles"] })
      qc.invalidateQueries({ queryKey: ["ipsec-profiles-picker"] })
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
      className="grid gap-4"
    >
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        error={fieldErrors.name}
      />
      <div className="grid grid-cols-3 gap-3">
        <FormSelect
          label="IKE version"
          value={String(ikeVersion)}
          onChange={(v) => setIkeVersion((Number(v) as IkeVersion) || 2)}
          options={IKE_VERSIONS}
        />
        <FormSelect
          label="Encryption"
          value={encryption}
          onChange={(v) =>
            setEncryption((v as IPSecEncryption) ?? "aes-256-cbc")
          }
          options={ENCRYPTIONS}
        />
        <FormSelect
          label="Authentication"
          value={authentication}
          onChange={(v) => setAuthentication((v as IPSecAuth) ?? "hmac-sha256")}
          options={AUTHS}
        />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <FormText
          label="DH group"
          type="number"
          value={dhGroup}
          onChange={setDhGroup}
          error={fieldErrors.dh_group}
        />
        <FormText
          label="PFS group"
          hint="blank = off"
          type="number"
          value={pfsGroup}
          onChange={setPfsGroup}
          error={fieldErrors.pfs_group}
        />
        <FormText
          label="SA lifetime (s)"
          type="number"
          value={saLifetime}
          onChange={setSaLifetime}
          error={fieldErrors.sa_lifetime}
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
        submitLabel={isEdit ? "Save changes" : "Create profile"}
      />
    </form>
  )
}
