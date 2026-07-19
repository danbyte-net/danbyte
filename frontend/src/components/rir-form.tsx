import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type RIR, type RIRWritePayload } from "@/lib/api"
import {
  FormCheckbox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface RirFormProps {
  rir?: RIR
  onSaved: (r: RIR) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function RirForm({ rir, onSaved, onCancel }: RirFormProps) {
  const isEdit = !!rir
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(rir?.name ?? "")
  const [slug, setSlug] = useState(rir?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [isPrivate, setIsPrivate] = useState(rir?.is_private ?? false)
  const [description, setDescription] = useState(rir?.description ?? "")

  useEffect(() => {
    if (!rir) return
    setName(rir.name)
    setSlug(rir.slug)
    setSlugDirty(true)
    setIsPrivate(rir.is_private)
    setDescription(rir.description)
    reset()
  }, [rir, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RIRWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        is_private: isPrivate,
        description: description.trim(),
      }
      if (isEdit)
        return api<RIR>(`/api/rirs/${rir!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<RIR>("/api/rirs/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["rirs"] })
      qc.invalidateQueries({ queryKey: ["rirs-picker"] })
      qc.invalidateQueries({ queryKey: ["rir", saved.id] })
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
        onChange={onNameChange}
        placeholder="ARIN, RIPE, RFC1918…"
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
      <FormCheckbox
        label="Private space"
        checked={isPrivate}
        onChange={setIsPrivate}
        hint="Non-globally-routed (RFC1918, ULA, …)"
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
        submitLabel={isEdit ? "Save changes" : "Create RIR"}
      />
    </form>
  )
}
