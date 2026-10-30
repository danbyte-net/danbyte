import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { EolCustomProduct } from "@/lib/api"
import {
  FormFooter,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface EolProductFormProps {
  product?: EolCustomProduct
  onSaved: (p: EolCustomProduct) => void
  onCancel: () => void
}

function keyOf(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.+_]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 128)
}

/** A tenant's own end-of-life product: its name, key, link and notes. The
 * cycles are edited on the product's page. */
export function EolProductForm({
  product,
  onSaved,
  onCancel,
}: EolProductFormProps) {
  const isEdit = !!product
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const [label, setLabel] = useState(product?.label ?? "")
  const [name, setName] = useState(product?.name ?? "")
  const [nameDirty, setNameDirty] = useState(isEdit)
  const [link, setLink] = useState(product?.link ?? "")
  const [notes, setNotes] = useState(product?.notes ?? "")

  const mutation = useMutation({
    mutationFn: () => {
      const payload = {
        label: label.trim(),
        link: link.trim(),
        notes: notes.trim(),
        ...(isEdit ? {} : { name: name.trim() || keyOf(label) }),
      }
      return api<EolCustomProduct>(
        isEdit
          ? `/api/eol/custom-products/${product.id}/`
          : "/api/eol/custom-products/",
        {
          method: isEdit ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        }
      )
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["eol-custom-products"] })
      qc.invalidateQueries({ queryKey: ["eol-custom-product", saved.id] })
      qc.invalidateQueries({ queryKey: ["eol-products"] })
      toast.success(
        isEdit ? `Updated ${saved.label}` : `Created ${saved.label}`
      )
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
      <FormSection title="End-of-life product" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={label}
            onChange={(v) => {
              setLabel(v)
              if (!nameDirty) setName(keyOf(v))
            }}
            placeholder="Acme ERP"
            error={fieldErrors.label}
          />
          <FormText
            label="Key"
            info="What applications and platforms name the product by. Set once."
            placeholder="acme-erp"
            value={name}
            onChange={(v) => {
              setNameDirty(true)
              setName(keyOf(v))
            }}
            disabled={isEdit}
            mono
            error={fieldErrors.name}
          />
        </div>
        <FormText
          label="Link"
          type="url"
          placeholder="https://"
          value={link}
          onChange={setLink}
          error={fieldErrors.link}
        />
        <FormTextarea
          label="Notes"
          value={notes}
          onChange={setNotes}
          error={fieldErrors.notes}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create product"}
      />
    </form>
  )
}
