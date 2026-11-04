import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Power, PowerOff } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  BatchFailure,
  IDS_PER_CALL,
  batchStoppedToast,
  runBatches,
  sumOf,
} from "@/lib/bulk-batches"
import { Button } from "@/components/ui/button"

/** The words of one direction: the button, its pending label and the toast. */
export interface FlagWords {
  label: string
  pending: string
  done: string
}

export const ENABLE_WORDS: [FlagWords, FlagWords] = [
  { label: "Enable", pending: "Enabling…", done: "Enabled" },
  { label: "Disable", pending: "Disabling…", done: "Disabled" },
]

export const ACTIVATE_WORDS: [FlagWords, FlagWords] = [
  { label: "Activate", pending: "Activating…", done: "Activated" },
  { label: "Deactivate", pending: "Deactivating…", done: "Deactivated" },
]

const plural = (n: number, [one, many]: [string, string]) =>
  `${n} ${n === 1 ? one : many}`

/**
 * Turn one yes/no field on or off for the selection - a list's Enable and
 * Disable. Writes through the list's `bulk-update/`, so the server's checks,
 * change log and grants are the bulk edit's; more rows than one call takes
 * go in batches.
 */
export function BulkFlagActions({
  endpoint,
  field,
  ids,
  noun,
  invalidate,
  onDone,
  words = ENABLE_WORDS,
}: {
  /** The list endpoint; `bulk-update/` is appended. */
  endpoint: string
  /** The boolean the buttons set: `enabled`, `is_active`. */
  field: string
  ids: string[]
  noun: [string, string]
  invalidate: string[][]
  onDone: () => void
  words?: [FlagWords, FlagWords]
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: async (value: boolean) => {
      const answers = await runBatches(ids, IDS_PER_CALL, (part) =>
        api<{ updated: number }>(`${endpoint}bulk-update/`, {
          method: "POST",
          body: JSON.stringify({ ids: part, fields: { [field]: value } }),
        })
      )
      return sumOf(answers, (a) => a.updated)
    },
    onSuccess: (n, value) => {
      toast.success(`${words[value ? 0 : 1].done} ${plural(n, noun)}`)
      onDone()
    },
    onError: (e, value) => {
      if (!(e instanceof BatchFailure)) {
        apiErrorToast(e)
        return
      }
      const went: { updated: number }[] = e.results
      batchStoppedToast(
        `${words[value ? 0 : 1].done} ${sumOf(went, (r) => r.updated)} of ${plural(ids.length, noun)}.`,
        e
      )
    },
    onSettled: () =>
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k })),
  })
  const busy = m.isPending ? m.variables : undefined
  return (
    <>
      {([true, false] as const).map((value) => {
        const w = words[value ? 0 : 1]
        const Icon = value ? Power : PowerOff
        return (
          <Button
            key={w.label}
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={m.isPending}
            onClick={() => m.mutate(value)}
          >
            <Icon className="mr-1 h-3 w-3" />
            {busy === value ? w.pending : w.label}
          </Button>
        )
      })}
    </>
  )
}
