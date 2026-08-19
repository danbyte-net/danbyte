import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { BulkFieldSpec, EditableFieldSpec } from "@/components/forms"

/** One model the server will accept field-level writes for. */
export interface EditableModel {
  slug: string
  model: string
  label: string
  field_count: number
}

/**
 * Narrow an untrusted server descriptor to the authored `BulkFieldSpec` union
 * so one `<FieldEditor/>` renders both. Returns null when the payload can't
 * satisfy its own `kind` - a `choice` without `choices` is a backend bug, and
 * silently degrading it to a text box is how a typo becomes stored data.
 */
export function toFieldSpec(f: EditableFieldSpec): BulkFieldSpec | null {
  const base = { key: f.key, label: f.label, hint: f.hint }
  switch (f.kind) {
    case "text":
    case "int":
    case "bool":
    case "vlan":
    case "vrf":
      return { ...base, kind: f.kind, suggestions: f.suggestions }
    case "bytes":
      return { ...base, kind: "bytes" }
    case "choice":
      return f.choices ? { ...base, kind: "choice", choices: f.choices } : null
    case "options":
      return f.options ? { ...base, kind: "options", options: f.options } : null
    case "status":
      // The wire uses snake_case; the authored union uses statusModel.
      return f.status_model
        ? { ...base, kind: "status", statusModel: f.status_model }
        : null
    case "object":
      return f.object_model
        ? { ...base, kind: "object", object_model: f.object_model }
        : null
    default:
      return null
  }
}

/** Models the caller may write field-by-field. Static per deployment. */
export function useEditableModels() {
  const q = useQuery({
    queryKey: ["editable-models"],
    queryFn: () => api<{ models: EditableModel[] }>("/api/editable-fields/"),
    staleTime: 60 * 60_000,
  })
  return { models: q.data?.models ?? [], isLoading: q.isLoading }
}

/** The writable fields of one model, already narrowed for `<FieldEditor/>`. */
export function useEditableFields(slug: string | null) {
  const q = useQuery({
    queryKey: ["editable-fields", slug],
    queryFn: () =>
      api<{ fields: EditableFieldSpec[] }>(
        `/api/editable-fields/?model=${slug}`
      ),
    enabled: !!slug,
    staleTime: 60 * 60_000,
  })
  const raw = q.data?.fields ?? []
  const specs = raw
    .map((f) => ({ raw: f, spec: toFieldSpec(f) }))
    .filter(
      (p): p is { raw: EditableFieldSpec; spec: BulkFieldSpec } => !!p.spec
    )
  return { fields: specs, isLoading: q.isLoading, error: q.error }
}
