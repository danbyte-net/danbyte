import type { BatchProgress } from "@/lib/bulk-batches"
import { cn } from "@/lib/utils"

/**
 * A labelled button's text that keeps the button's size while it works: the
 * label at rest, then the verb (`Deleting…`) - and for a run in several
 * batches the batch on its way (`Deleting… 2 / 3`). Every text it can show
 * shares one grid cell, so the widest sizes the button from the start and
 * nothing moves as the count goes up. What is hidden is hidden from screen
 * readers too: the button's name is what it shows.
 */
export function PendingLabel({
  label,
  verb,
  pending,
  progress = null,
  batches = 1,
}: {
  /** At rest: `Delete 2400`. */
  label: React.ReactNode
  /** At work: `Deleting…`. */
  verb: string
  pending: boolean
  /** The batch on its way - what `runBatches` reports. */
  progress?: BatchProgress | null
  /** How many batches the run takes. With one, the verb stands alone. */
  batches?: number
}) {
  const counted = batches > 1
  const busy = counted ? `${verb} ${progress?.batch ?? 1} / ${batches}` : verb
  return (
    <span className="grid tabular-nums">
      <Cell shown={!pending}>{label}</Cell>
      <Cell shown={pending}>{busy}</Cell>
      {counted && (
        <Cell shown={false}>{`${verb} ${batches} / ${batches}`}</Cell>
      )}
    </span>
  )
}

function Cell({
  shown,
  children,
}: {
  shown: boolean
  children: React.ReactNode
}) {
  return (
    <span
      className={cn("col-start-1 row-start-1", !shown && "invisible")}
      aria-hidden={shown ? undefined : true}
    >
      {children}
    </span>
  )
}
