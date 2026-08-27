import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type BusinessHours,
  type Contact,
  type ContactGroupOption,
  type ContactWritePayload,
  type Paginated,
} from "@/lib/api"
import { BusinessHoursField } from "@/components/business-hours-field"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  QuickAddDialog,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface ContactFormProps {
  contact?: Contact
  onSaved: (c: Contact) => void
  onCancel: () => void
}

export function ContactForm({ contact, onSaved, onCancel }: ContactFormProps) {
  const isEdit = !!contact
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(contact?.name ?? "")
  const [title, setTitle] = useState(contact?.title ?? "")
  const [phone, setPhone] = useState(contact?.phone ?? "")
  const [email, setEmail] = useState(contact?.email ?? "")
  const [link, setLink] = useState(contact?.link ?? "")
  const [address, setAddress] = useState(contact?.address ?? "")
  const [comments, setComments] = useState(contact?.comments ?? "")
  const [hours, setHours] = useState<BusinessHours>(
    contact?.business_hours ?? {}
  )
  const [hoursTz, setHoursTz] = useState(contact?.business_hours_tz ?? "")
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
    setHours(contact.business_hours ?? {})
    setHoursTz(contact.business_hours_tz ?? "")
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
        business_hours: hours,
        business_hours_tz: hoursTz,
        group_id: groupId,
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<Contact>({
        objectType: "api.contact",
        endpoint: "/api/contacts/",
        id: isEdit ? contact!.id : undefined,
        payload,
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Contact" card>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              placeholder="Jane Doe"
              value={name}
              onChange={setName}
              error={fieldErrors.name}
            />
            <FormText
              label="Title"
              hint="optional"
              placeholder="Network Engineer"
              value={title}
              onChange={setTitle}
              error={fieldErrors.title}
            />
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
                    qc.invalidateQueries({
                      queryKey: ["contact-groups-picker"],
                    })
                    setGroupId(g.id)
                  }}
                />
              }
            />
          </FormSection>

          <FormSection title="Address" card>
            <FormTextarea
              label="Address"
              rows={2}
              value={address}
              onChange={setAddress}
              error={fieldErrors.address}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Reachability" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Email"
                type="email"
                placeholder="jane@acme.io"
                value={email}
                onChange={setEmail}
                error={fieldErrors.email}
              />
              <FormText
                label="Phone"
                placeholder="+1 555 0100"
                value={phone}
                onChange={setPhone}
                error={fieldErrors.phone}
              />
            </div>
            <FormText
              label="Link"
              hint="optional"
              type="url"
              placeholder="https://…"
              value={link}
              onChange={setLink}
              error={fieldErrors.link}
            />
          </FormSection>

          <FormSection title="Working hours" card>
            <BusinessHoursField
              label="Reachable"
              hint="optional"
              value={hours}
              tz={hoursTz}
              onChange={setHours}
              onTzChange={setHoursTz}
              error={fieldErrors.business_hours ?? fieldErrors.business_hours_tz}
            />
          </FormSection>

          <FormSection title="Notes" card>
            <FormTextarea
              label="Comments"
              rows={2}
              value={comments}
              onChange={setComments}
              error={fieldErrors.comments}
            />
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="contact"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create contact"}
      />
    </form>
  )
}
