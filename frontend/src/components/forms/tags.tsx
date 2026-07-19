import { useQuery } from "@tanstack/react-query"

import { api, type Paginated, type TagOption } from "@/lib/api"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { Field, type FieldProps } from "./field"

type Base = Omit<FieldProps, "children">

export interface FormTagsProps extends Base {
  value: number[]
  onChange: (v: number[]) => void
}

// Self-contained tag picker — fetches the tag list once (cached
// 10 min, shared across every dialog that uses this) and renders the
// TagMultiSelect. Forms don't need to wire the query themselves.
export function FormTags({ value, onChange, ...field }: FormTagsProps) {
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  return (
    <Field {...field}>
      <TagMultiSelect
        options={tags.data?.results ?? []}
        value={value}
        onChange={onChange}
      />
    </Field>
  )
}
