import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { Provider, ProviderWritePayload } from "@/lib/api"
import {
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
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
    setComments(provider.comments)
    setTagIds(provider.tags.map((t) => t.id))
    setCustomFields(provider.custom_fields ?? {})
    reset()
  }, [provider, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ProviderWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        account: account.trim(),
        portal_url: portalUrl.trim(),
        noc_email: nocEmail.trim(),
        noc_phone: nocPhone.trim(),
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
        <FormText
          label="Portal URL"
          type="url"
          placeholder="https://…"
          value={portalUrl}
          onChange={setPortalUrl}
          error={fieldErrors.portal_url}
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
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create provider"}
      />
    </form>
  )
}
