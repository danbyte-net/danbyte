import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type Provider,
  type ProviderWritePayload,
  type TagOption,
} from "@/lib/api"
import {
  Field,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

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

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
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
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<Provider>(`/api/providers/${provider!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Provider>("/api/providers/", {
        method: "POST",
        body: JSON.stringify(payload),
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
      className="grid gap-4"
    >
      <div className="grid grid-cols-2 gap-3">
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
          required
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
      <div className="grid grid-cols-2 gap-3">
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
      <FormTextarea
        label="Comments"
        value={comments}
        onChange={setComments}
        error={fieldErrors.comments}
      />
      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
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
