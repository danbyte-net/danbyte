import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Pencil } from "lucide-react"

import { api } from "@/lib/api"
import type { Paginated, PowerPanelOption } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { BulkEditDialog } from "@/components/bulk-edit-dialog"
import type { BulkFieldSpec } from "@/components/forms"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"

// The selection bars of the power lists (#313): the safe bulk delete - a
// dry run first, kept rows named - plus Edit, the shared KEEP/SET dialog.
// Both send a selection bigger than one call takes in batches.

// Every query a power write can move: the lists, the embedded feed tables,
// a panel's feed count and a rack's power roll-up.
const INVALIDATE = [
  ["power-feeds"],
  ["power-feed"],
  ["embedded-power-feeds"],
  ["power-panels"],
  ["power-panel"],
  ["rack"],
]

const TYPES = [
  { value: "primary", label: "Primary" },
  { value: "redundant", label: "Redundant" },
]
const SUPPLIES = [
  { value: "ac", label: "AC" },
  { value: "dc", label: "DC" },
]
const PHASES = [
  { value: "single", label: "Single phase" },
  { value: "three", label: "Three phase" },
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

export function PowerFeedBulkBar({
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
  const panels = useQuery({
    queryKey: ["power-panels-picker"],
    queryFn: () =>
      api<Paginated<PowerPanelOption>>("/api/power-panels/?picker=1"),
    staleTime: 10 * 60_000,
    enabled: editing,
  })
  const fields: BulkFieldSpec[] = [
    {
      key: "status_id",
      label: "Status",
      kind: "status",
      statusModel: "powerfeed",
    },
    { key: "type", label: "Type", kind: "options", options: TYPES },
    { key: "supply", label: "Supply", kind: "options", options: SUPPLIES },
    { key: "phase", label: "Phase", kind: "options", options: PHASES },
    { key: "voltage", label: "Voltage", kind: "int" },
    { key: "amperage", label: "Amperage", kind: "int" },
    { key: "max_utilization", label: "Max utilization", kind: "int" },
    {
      key: "power_panel_id",
      label: "Power panel",
      kind: "options",
      options: (panels.data?.results ?? []).map((p) => ({
        value: p.id,
        label: p.name,
      })),
    },
    { key: "rack_id", label: "Rack", kind: "object", object_model: "rack" },
  ]
  return (
    <>
      <SafeBulkDeleteBar
        selected={selected}
        endpoint="/api/power-feeds/"
        noun={["power feed", "power feeds"]}
        invalidate={INVALIDATE}
        onCleared={onCleared}
        canDelete={canDelete}
        actions={canEdit && <EditButton onClick={() => setEditing(true)} />}
      />
      {editing && selected.length > 0 && (
        <BulkEditDialog
          endpoint="/api/power-feeds/"
          noun={["power feed", "power feeds"]}
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

const PANEL_FIELDS: BulkFieldSpec[] = [
  { key: "site_id", label: "Site", kind: "object", object_model: "site" },
]

export function PowerPanelBulkBar({
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
        endpoint="/api/power-panels/"
        noun={["power panel", "power panels"]}
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
          endpoint="/api/power-panels/"
          noun={["power panel", "power panels"]}
          ids={selected.map((r) => r.id)}
          fields={PANEL_FIELDS}
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
