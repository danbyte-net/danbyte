import { TableIO } from "@/components/table-io"

/**
 * Header action cluster for list pages — sits next to the "Add …" button.
 * Renders a prominent **Import / Export** control (round-trip data) when the
 * given object type is IO-capable for the user; renders nothing otherwise.
 */
export function TableActions({
  ioType,
  name,
  selectedIds,
  exportFilter,
}: {
  ioType: string
  name?: string
  /** Restrict export to these row ids (e.g. a single object on a detail page). */
  selectedIds?: string[]
  /** Narrow the export by model field, e.g. `{ prefix: id }`. */
  exportFilter?: Record<string, string>
}) {
  return (
    <TableIO
      slug={ioType}
      name={name}
      selectedIds={selectedIds}
      exportFilter={exportFilter}
      prominent
    />
  )
}
