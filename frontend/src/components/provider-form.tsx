import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type BusinessHours,
  type ContactMini,
  type Paginated,
  type Provider,
  type ProviderWritePayload,
} from "@/lib/api"
import {
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { BusinessHoursField } from "@/components/business-hours-field"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

export interface ProviderFormProps {
  provider?: Provider
  onSaved: (v: Provider) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function ProviderForm({
  provider,
  onSaved,
  onCancel,
}: ProviderFormProps) {
  const isEdit = !!provider
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(provider?.name ?? "")
  const [slug, setSlug] = useState(provider?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [account, setAccount] = useState(provider?.account ?? "")
  const [portalUrl, setPortalUrl] = useState(provider?.portal_url ?? "")
  const [nocEmail, setNocEmail] = useState(provider?.noc_email ?? "")
  const [nocPhone, setNocPhone] = useState(provider?.noc_phone ?? "")
  const [comments, setComments] = useState(provider?.comments ?? "")
  const [supportContract, setSupportContract] = useState(
    provider?.support_contract ?? ""
  )
  const [supportPhone, setSupportPhone] = useState(provider?.support_phone ?? "")
  const [managerId, setManagerId] = useState<string | null>(
    provider?.account_manager?.id ?? null
  )
  const [managerName, setManagerName] = useState(
    provider?.account_manager_name ?? ""
  )
  const [hours, setHours] = useState<BusinessHours>(
    provider?.business_hours ?? {}
  )
  const [hoursTz, setHoursTz] = useState(provider?.business_hours_tz ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    provider?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    provider?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!provider) return
    setName(provider.name)
    setSlug(provider.slug)
    setSlugDirty(true)
    setAccount(provider.account)
    setPortalUrl(provider.portal_url)
    setNocEmail(provider.noc_email)
    setNocPhone(provider.noc_phone)
    setSupportContract(provider.support_contract)
    setSupportPhone(provider.support_phone)
    setManagerId(provider.account_manager?.id ?? null)
    setManagerName(provider.account_manager_name)
    setHours(provider.business_hours ?? {})
    setHoursTz(provider.business_hours_tz ?? "")
    setComments(provider.comments)
    setTagIds(provider.tags.map((t) => t.id))
    setCustomFields(provider.custom_fields ?? {})
    reset()
  }, [provider, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const contacts = useQuery({
    queryKey: ["contacts-picker"],
    queryFn: () => api<Paginated<ContactMini>>("/api/contacts/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ProviderWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        account: account.trim(),
        portal_url: portalUrl.trim(),
        noc_email: nocEmail.trim(),
        noc_phone: nocPhone.trim(),
        support_contract: supportContract.trim(),
        support_phone: supportPhone.trim(),
        account_manager_id: managerId,
        account_manager_name: managerName.trim(),
        business_hours: hours,
        business_hours_tz: hoursTz,
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<Provider>({
        objectType: "api.provider",
        endpoint: "/api/providers/",
        id: isEdit ? provider!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["providers"] })
      qc.invalidateQueries({ queryKey: ["providers-picker"] })
      qc.invalidateQueries({ queryKey: ["provider", saved.id] })
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
      <FormColumns>
        <FormColumn>
      <FormSection title="Provider" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={onNameChange}
            error={fieldErrors.name}
          />
          <FormText
            label="Slug"
            hint="URL-safe id"
            value={slug}
            onChange={(v) => {
              setSlugDirty(true)
              setSlug(slugify(v))
            }}
            mono
            error={fieldErrors.slug}
          />
        </div>
        <FormText
          label="Account"
          hint="optional"
          value={account}
          onChange={setAccount}
          error={fieldErrors.account}
        />
      </FormSection>

      <FormSection title="Support" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="NOC email"
            type="email"
            value={nocEmail}
            onChange={setNocEmail}
            error={fieldErrors.noc_email}
          />
          <FormText
            label="NOC phone"
            value={nocPhone}
            onChange={setNocPhone}
            error={fieldErrors.noc_phone}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Support contract"
            hint="quoted when opening a case"
            value={supportContract}
            onChange={setSupportContract}
            error={fieldErrors.support_contract}
          />
          <FormText
            label="Support phone"
            hint="optional"
            value={supportPhone}
            onChange={setSupportPhone}
            error={fieldErrors.support_phone}
          />
        </div>
        <FormText
          label="Portal URL"
          type="url"
          placeholder="https://…"
          value={portalUrl}
          onChange={setPortalUrl}
          error={fieldErrors.portal_url}
        />
      </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Support hours" card>
            <BusinessHoursField
              label="Reachable"
              hint="optional"
              value={hours}
              tz={hoursTz}
              onChange={setHours}
              onTzChange={setHoursTz}
              error={
                fieldErrors.business_hours ?? fieldErrors.business_hours_tz
              }
            />
          </FormSection>

          <FormSection title="Account manager" card>
            <FormCombobox
              label="Contact"
              hint="optional"
              value={managerId}
              onChange={setManagerId}
              options={(contacts.data?.results ?? []).map((c) => ({
                value: c.id,
                label: c.name,
              }))}
              noneLabel="No contact"
              placeholder="Select a contact…"
              searchPlaceholder="Search contacts…"
              emptyText="No contacts."
              error={fieldErrors.account_manager_id}
            />
            <FormText
              label="Name"
              hint="when they have no contact record"
              value={managerName}
              onChange={setManagerName}
              error={fieldErrors.account_manager_name}
            />
          </FormSection>

      <FormSection title="Notes" card>
        <FormTextarea
          label="Comments"
          value={comments}
          onChange={setComments}
          error={fieldErrors.comments}
        />
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="provider"
        value={customFields}
        onChange={setCustomFields}
      />
        </FormColumn>
      </FormColumns>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create provider"}
      />
    </form>
  )
}
