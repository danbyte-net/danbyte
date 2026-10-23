import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Pencil } from "lucide-react"

import { api } from "@/lib/api"
import type { CoolingSourceOption, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { BulkEditDialog } from "@/components/bulk-edit-dialog"
import type { BulkFieldSpec } from "@/components/forms"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"

// The selection bars of the cooling lists (#434), shaped like the power
// ones: the safe bulk delete - a dry run first, kept rows named - plus Edit,
// the shared KEEP/SET dialog.

// Every query a cooling write can move: the lists, the embedded feed tables,
// a source's feed count and load, and a rack's cooling roll-up.
const INVALIDATE = [
  ["cooling-feeds"],
  ["cooling-feed"],
  ["embedded-cooling-feeds"],
  ["cooling-sources"],
  ["cooling-source"],
  ["rack"],
]

interface Row {
  id: string
  name: string
}

function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClick}>
      <Pencil className="mr-1 h-3 w-3" /> Edit
    </Button>
  )
}

export function CoolingFeedBulkBar({
  selected,
  onCleared,
  canEdit,
  canDelete,
}: {
  selected: Row[]
  onCleared: () => void
  canEdit: boolean
  canDelete: boolean
}) {
  const [editing, setEditing] = useState(false)
  const sources = useQuery({
    queryKey: ["cooling-sources-picker"],
    queryFn: () =>
      api<Paginated<CoolingSourceOption>>("/api/cooling-sources/?picker=1"),
    staleTime: 10 * 60_000,
    enabled: editing,
  })
  const fields: BulkFieldSpec[] = [
    {
      key: "status_id",
      label: "Status",
      kind: "status",
      statusModel: "coolingfeed",
    },
    {
      key: "type",
      label: "Type",
      kind: "choice",
      choices: "cooling_feed_types",
    },
    { key: "rated_capacity_w", label: "Rated capacity (W)", kind: "int" },
    { key: "max_utilization", label: "Max utilization", kind: "int" },
    { key: "connector", label: "Connector", kind: "text" },
    {
      key: "source_id",
      label: "Cooling source",
      kind: "options",
      options: (sources.data?.results ?? []).map((s) => ({
        value: s.id,
        label: s.name,
      })),
    },
    { key: "rack_id", label: "Rack", kind: "object", object_model: "rack" },
  ]
  return (
    <>
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/cooling-feeds/"
        noun={["cooling feed", "cooling feeds"]}
        invalidate={INVALIDATE}
        onCleared={onCleared}
        canDelete={canDelete}
        actions={canEdit && <EditButton onClick={() => setEditing(true)} />}
      />
      {editing && selected.length > 0 && (
        <BulkEditDialog
          endpoint="/api/cooling-feeds/"
          noun={["cooling feed", "cooling feeds"]}
          ids={selected.map((r) => r.id)}
          fields={fields}
          tags
          invalidate={INVALIDATE}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false)
            onCleared()
          }}
        />
      )}
    </>
  )
}

const SOURCE_FIELDS: BulkFieldSpec[] = [
  {
    key: "status_id",
    label: "Status",
    kind: "status",
    statusModel: "coolingsource",
  },
  {
    key: "type",
    label: "Type",
    kind: "choice",
    choices: "cooling_source_types",
  },
  { key: "fluid", label: "Fluid", kind: "choice", choices: "cooling_fluids" },
  { key: "rated_capacity_w", label: "Rated capacity (W)", kind: "int" },
  { key: "redundancy_group", label: "Redundancy group", kind: "text" },
  { key: "site_id", label: "Site", kind: "object", object_model: "site" },
  // A source's location must be in its site: a site move of sources that
  // have one changes or clears the location in the same edit.
  {
    key: "location_id",
    label: "Location",
    kind: "object",
    object_model: "location",
  },
]

export function CoolingSourceBulkBar({
  selected,
  onCleared,
  canEdit,
  canDelete,
  canDeleteFeeds,
}: {
  selected: Row[]
  onCleared: () => void
  canEdit: boolean
  canDelete: boolean
  /** Offer "Delete their feeds too"; the server checks each feed again. */
  canDeleteFeeds: boolean
}) {
  const [editing, setEditing] = useState(false)
  return (
    <>
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/cooling-sources/"
        noun={["cooling source", "cooling sources"]}
        invalidate={INVALIDATE}
        onCleared={onCleared}
        canDelete={canDelete}
        option={
          canDeleteFeeds
            ? { key: "with_feeds", label: "Delete their feeds too" }
            : undefined
        }
        actions={canEdit && <EditButton onClick={() => setEditing(true)} />}
      />
      {editing && selected.length > 0 && (
        <BulkEditDialog
          endpoint="/api/cooling-sources/"
          noun={["cooling source", "cooling sources"]}
          ids={selected.map((r) => r.id)}
          fields={SOURCE_FIELDS}
          tags
          invalidate={INVALIDATE}
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false)
            onCleared()
          }}
        />
      )}
    </>
  )
}
