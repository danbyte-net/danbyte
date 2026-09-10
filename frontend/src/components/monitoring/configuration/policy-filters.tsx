import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronDown, Filter } from "lucide-react"

import { api } from "@/lib/api"
import type { MonitoringPolicy, Paginated, TagOption } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FormFooter, FormText } from "@/components/forms"
import { IdMultiSelect } from "@/components/cells/id-multi-select"

/**
 * Narrow a policy to some of what its scope matched.
 *
 * Filters rather than scopes: a scope needs a target object the permission
 * query can test, and a name pattern has none. They AND with the scope's
 * match, so a filter can only ever remove a policy from consideration - never
 * add a check, and never disable one a looser policy already added.
 */
export function PolicyFilterButton({
  policy,
  onSave,
  disabled,
}: {
  policy: MonitoringPolicy | undefined
  onSave: (patch: { match_name: string; match_tags: string[] }) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const name = policy?.match_name ?? ""
  const tags = policy?.match_tags ?? []

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        title="Narrow this policy to some of what its scope matches"
        onClick={() => setOpen(true)}
      >
        <Filter data-icon="inline-start" />
        <span>{summary(name, tags)}</span>
        <ChevronDown data-icon="inline-end" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Narrow this policy</DialogTitle>
          </DialogHeader>
          {open && (
            <FilterForm
              name={name}
              tags={tags}
              onCancel={() => setOpen(false)}
              onSave={(patch) => {
                onSave(patch)
                setOpen(false)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}

/** What the button says: the filters at a glance, or that there are none. */
function summary(name: string, tags: string[]): string {
  if (!name && tags.length === 0) return "Any"
  const parts: string[] = []
  if (name) parts.push(name)
  if (tags.length) parts.push(`${tags.length} tag${tags.length === 1 ? "" : "s"}`)
  return parts.join(" · ")
}

function FilterForm({
  name,
  tags,
  onSave,
  onCancel,
}: {
  name: string
  tags: string[]
  onSave: (patch: { match_name: string; match_tags: string[] }) => void
  onCancel: () => void
}) {
  const [pattern, setPattern] = useState(name)
  const [picked, setPicked] = useState<string[]>(tags)

  const options = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  // A tag on the policy that no longer exists still has to render, or editing
  // a policy would quietly drop it.
  const [known, setKnown] = useState<{ id: string; name: string }[]>([])
  useEffect(() => {
    const rows = (options.data?.results ?? []).map((t) => ({
      id: t.slug,
      name: t.name,
    }))
    const have = new Set(rows.map((r) => r.id))
    setKnown([
      ...rows,
      ...tags.filter((t) => !have.has(t)).map((t) => ({ id: t, name: t })),
    ])
  }, [options.data, tags])

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave({ match_name: pattern.trim(), match_tags: picked })
      }}
      className="grid gap-4"
    >
      <FormText
        label="Name matches"
        hint="A glob, e.g. core-*. Empty matches any name."
        value={pattern}
        onChange={setPattern}
        placeholder="core-*"
      />
      <Field
        label="Carries all these tags"
        hint="Empty matches any. Several tags means all of them."
      >
        <IdMultiSelect
          options={known}
          value={picked}
          onChange={setPicked}
          placeholder="Add a tag…"
          searchPlaceholder="Search tags…"
          emptyText="No tags."
        />
      </Field>
      <p className="text-[11px] text-muted-foreground">
        Filters read the device, so a filtered policy never reaches an address
        with nothing on it.
      </p>
      <FormFooter onCancel={onCancel} submitLabel="Save" />
    </form>
  )
}
