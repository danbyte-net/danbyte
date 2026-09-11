import { useState } from "react"
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
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

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
  onSave: (patch: {
    match_name: string
    match_tags: string[]
    match_interface: string
  }) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const name = policy?.match_name ?? ""
  const tags = policy?.match_tags ?? []
  const iface = policy?.match_interface ?? ""

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            aria-label={`Filters: ${summary(name, tags, iface)}`}
            onClick={() => setOpen(true)}
          >
            <Filter data-icon="inline-start" />
            <span>{summary(name, tags, iface)}</span>
            <ChevronDown data-icon="inline-end" />
          </Button>
        </TooltipTrigger>
        <TooltipContent variant="panel">Narrow which devices this applies to</TooltipContent>
      </Tooltip>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Narrow this policy</DialogTitle>
          </DialogHeader>
          {open && (
            <FilterForm
              name={name}
              tags={tags}
              iface={iface}
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
function summary(name: string, tags: string[], iface: string): string {
  const parts: string[] = []
  if (name) parts.push(name)
  if (iface) parts.push(iface)
  if (tags.length) parts.push(`${tags.length} tag${tags.length === 1 ? "" : "s"}`)
  return parts.length ? parts.join(" · ") : "Any"
}

function FilterForm({
  name,
  tags,
  iface,
  onSave,
  onCancel,
}: {
  name: string
  tags: string[]
  iface: string
  onSave: (patch: {
    match_name: string
    match_tags: string[]
    match_interface: string
  }) => void
  onCancel: () => void
}) {
  const [pattern, setPattern] = useState(name)
  const [picked, setPicked] = useState<string[]>(tags)
  const [port, setPort] = useState(iface)
  const options = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  // The filter stores slugs; the shared tag picker works in ids and draws each
  // tag in its colour. Map at the edge so the policy stays portable.
  const tagRows = options.data?.results ?? []
  const pickedIds = tagRows.filter((t) => picked.includes(t.slug)).map((t) => t.id)
  const onTags = (ids: number[]) =>
    setPicked([
      ...tagRows.filter((t) => ids.includes(t.id)).map((t) => t.slug),
      // A slug the catalog no longer has stays on the policy rather than being
      // dropped by an edit of something else.
      ...picked.filter((slug) => !tagRows.some((t) => t.slug === slug)),
    ])


  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        onSave({
          match_name: pattern.trim(),
          match_tags: picked,
          match_interface: port.trim(),
        })
      }}
      className="grid gap-4"
    >
      <FormText
        label="Name"
        hint="glob, e.g. core-*"
        value={pattern}
        onChange={setPattern}
        placeholder="core-*"
      />
      <FormText
        label="Interface"
        hint="glob, e.g. Gi0/0/*"
        info="Reads the address's own port, not the device. An address bound to no interface never matches a set filter."
        value={port}
        onChange={setPort}
        placeholder="Gi0/0/*"
      />
      <Field
        label="Tags"
        hint="all of them"
        info="Name and tags read the device, so a policy filtered on either never reaches an address with nothing on it. Every filter narrows; none can add or disable a check."
      >
        <TagMultiSelect
          options={tagRows}
          value={pickedIds}
          onChange={onTags}
          placeholder="Add a tag…"
        />
      </Field>
      <FormFooter onCancel={onCancel} submitLabel="Save" />
    </form>
  )
}
