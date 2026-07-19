import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Contact,
  type ContactGroupOption,
  type ContactWritePayload,
  type Paginated,
  type TagOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  FormCombobox,
  QuickAddDialog,
  useFieldErrors,
} from "@/components/forms"

export interface ContactFormProps {
  contact?: Contact
  onSaved: (c: Contact) => void
  onCancel: () => void
}

export function ContactForm({ contact, onSaved, onCancel }: ContactFormProps) {
  const isEdit = !!contact
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(contact?.name ?? "")
  const [title, setTitle] = useState(contact?.title ?? "")
  const [phone, setPhone] = useState(contact?.phone ?? "")
  const [email, setEmail] = useState(contact?.email ?? "")
  const [link, setLink] = useState(contact?.link ?? "")
  const [address, setAddress] = useState(contact?.address ?? "")
  const [comments, setComments] = useState(contact?.comments ?? "")
  const [groupId, setGroupId] = useState<string | null>(
    contact?.group?.id ?? null
  )
  const [tagIds, setTagIds] = useState<number[]>(
    contact?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    contact?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!contact) return
    setName(contact.name)
    setTitle(contact.title)
    setPhone(contact.phone)
    setEmail(contact.email)
    setLink(contact.link)
    setAddress(contact.address)
    setComments(contact.comments)
    setGroupId(contact.group?.id ?? null)
    setTagIds(contact.tags.map((t) => t.id))
    setCustomFields(contact.custom_fields ?? {})
    reset()
  }, [contact, reset])

  const groups = useQuery({
    queryKey: ["contact-groups-picker"],
    queryFn: () =>
      api<Paginated<ContactGroupOption>>("/api/contact-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ContactWritePayload = {
        name: name.trim(),
        title: title.trim(),
        phone: phone.trim(),
        email: email.trim(),
        link: link.trim(),
        address: address.trim(),
        comments: comments.trim(),
        group_id: groupId,
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<Contact>(`/api/contacts/${contact!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Contact>("/api/contacts/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["contacts"] })
      qc.invalidateQueries({ queryKey: ["contact", saved.id] })
      qc.invalidateQueries({ queryKey: ["contacts-picker"] })
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
        <Field label="Name" error={fieldErrors.name}>
          <Input
            autoFocus={!isEdit}
            required
            placeholder="Jane Doe"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
        <Field label="Title" error={fieldErrors.title}>
          <Input
            placeholder="Network Engineer"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Email" error={fieldErrors.email}>
          <Input
            type="email"
            placeholder="jane@acme.io"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Phone" error={fieldErrors.phone}>
          <Input
            placeholder="+1 555 0100"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="Group"
          hint="optional"
          value={groupId}
          onChange={setGroupId}
          options={(groups.data?.results ?? []).map((g) => ({
            value: g.id,
            label: g.name,
          }))}
          noneLabel="No group"
          placeholder="No group"
          searchPlaceholder="Search groups…"
          emptyText="No groups."
          error={fieldErrors.group_id}
          quickAdd={
            <QuickAddDialog
              title="New contact group"
              endpoint="/api/contact-groups/"
              fields={[
                { name: "name", label: "Name", required: true },
                {
                  name: "description",
                  label: "Description",
                  type: "textarea",
                },
              ]}
              onCreated={(g) => {
                qc.invalidateQueries({ queryKey: ["contact-groups-picker"] })
                setGroupId(g.id)
              }}
            />
          }
        />
        <Field label="Link" hint="optional" error={fieldErrors.link}>
          <Input
            type="url"
            placeholder="https://…"
            value={link}
            onChange={(e) => setLink(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Address" error={fieldErrors.address}>
        <Textarea
          rows={2}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
      </Field>

      <Field label="Comments" error={fieldErrors.comments}>
        <Textarea
          rows={2}
          value={comments}
          onChange={(e) => setComments(e.target.value)}
        />
      </Field>

      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>

      <CustomFieldInputs
        model="contact"
        value={customFields}
        onChange={setCustomFields}
      />

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create contact"}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-xs">{label}</Label>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
