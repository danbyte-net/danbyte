import { useQuery } from "@tanstack/react-query"

import { type TagOption } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { Field, type FieldProps } from "./field"

type Base = Omit<FieldProps, "children">

export interface FormTagsProps extends Base {
  value: number[]
  onChange: (v: number[]) => void
  /** Offer only the tenant's own tags, not deployment-global ones. */
  tenantOnly?: boolean
}

// Self-contained tag picker - fetches the tag list once (cached
// 10 min, shared across every dialog that uses this) and renders the
// TagMultiSelect. Forms don't need to wire the query themselves.
export function FormTags({
  value,
  onChange,
  tenantOnly,
  ...field
}: FormTagsProps) {
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => apiAll<TagOption>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const options = tags.data?.results ?? []
  return (
    <Field {...field}>
      <TagMultiSelect
        options={tenantOnly ? options.filter((t) => !t.is_global) : options}
        value={value}
        onChange={onChange}
      />
    </Field>
  )
}
