import { useEffect, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { Cable } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useSaveObject } from "@/lib/save-object"
import { partChoices, recordPayload } from "@/lib/stacks"
import type { StackLink } from "@/lib/stacks"
import { invalidateCableCaches } from "@/components/cable-form"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { FormFooter, FormSelect, FormText } from "@/components/forms"

/**
 * Record cable (docs/dcim/virtual-chassis.md → Record a derived cable):
 * one or more links of a stack's derived ring saved as real cables - the
 * two ports, the head's part number as the label and its length, type
 * `stack` or `stack-power`. Several at once share one length, editable per
 * row. Each is an ordinary cable create (cable add, scoped and audited as
 * any); the 3D views then draw it as recorded.
 */

/** A link to record and its line in the dialog. */
export interface RecordTarget {
  key: string
  /** `sw1 · StackPort1/1 → sw2 · StackPort2/2`. */
  line: string
  link: Pick<StackLink, "a" | "b" | "kind" | "parts" | "derived">
}

interface Row {
  part: string
  length: string
  unit: string
}

const UNITS = [
  { value: "m", label: "m" },
  { value: "cm", label: "cm" },
]

/** A row's first values: the head's shortest part and its length. */
function firstRow(t: RecordTarget): Row {
  const c = partChoices(t.link.parts).at(0)
  return c
    ? { part: c.part, length: String(c.length), unit: c.unit }
    : { part: "", length: "", unit: "m" }
}

/** A part number typed or picked: its length, when it reads, fills in. */
function withPart(row: Row, part: string, parts?: readonly string[]): Row {
  const hit =
    partChoices(parts ?? [part]).find((c) => c.part === part) ??
    partChoices([part]).at(0)
  return hit
    ? { part, length: String(hit.length), unit: hit.unit }
    : { ...row, part }
}

export function RecordStackCablesDialog({
  targets,
  onClose,
  onSaved,
}: {
  /** Null: closed. */
  targets: RecordTarget[] | null
  onClose: () => void
  onSaved?: () => void
}) {
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const [rows, setRows] = useState<Row[]>([])
  const [saving, setSaving] = useState(false)
  const key = targets?.map((t) => t.key).join("|") ?? ""
  useEffect(() => {
    setRows(targets?.map(firstRow) ?? [])
    // `key` stands for `targets`.
  }, [key])
  if (!targets) return null
  const many = targets.length > 1
  // Every part number any row's head offers, for the shared length.
  const allParts = [...new Set(targets.flatMap((t) => t.link.parts ?? []))]
  const set = (i: number, row: Row) =>
    setRows((prev) => prev.map((r, j) => (j === i ? row : r)))

  const submit = async () => {
    setSaving(true)
    let done = 0
    try {
      for (const [i, t] of targets.entries()) {
        await saveObject<Cable>({
          objectType: "api.cable",
          endpoint: "/api/cables/",
          payload: recordPayload(t.link, rows[i] ?? firstRow(t)),
        })
        done++
      }
      toast.success(done > 1 ? `${done} cables recorded` : "Cable recorded")
      onSaved?.()
      onClose()
    } catch (err) {
      if (done) toast.success(`${done} of ${targets.length} recorded`)
      apiErrorToast(err)
    } finally {
      setSaving(false)
      invalidateCableCaches(qc)
      qc.invalidateQueries({ queryKey: ["device-leds"] })
      qc.invalidateQueries({ queryKey: ["stack-links"] })
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent
        className={`max-h-[90vh] overflow-y-auto ${many ? "sm:max-w-2xl" : "sm:max-w-md"}`}
      >
        <DialogHeader>
          <DialogTitle>
            {many
              ? `Record ${targets.length} cables`
              : targets[0].link.kind === "power"
                ? "Record StackPower cable"
                : "Record stack cable"}
          </DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          {many && allParts.length > 0 && (
            <FormSelect
              label="Length for all"
              value={null}
              placeholder="Pick a part"
              options={partChoices(allParts).map((c) => ({
                value: c.part,
                label: c.part,
              }))}
              onChange={(part) => {
                if (!part) return
                setRows((prev) =>
                  prev.map((r, i) => withPart(r, part, targets[i].link.parts))
                )
              }}
            />
          )}
          <div className="flex flex-col gap-3">
            {targets.map((t, i) => {
              const row = rows[i] ?? firstRow(t)
              return (
                <div key={t.key} className="flex flex-col gap-1.5">
                  <div className="font-mono text-xs whitespace-nowrap text-muted-foreground">
                    {t.line}
                  </div>
                  <div className="grid grid-cols-[1fr_6rem_5rem] gap-2">
                    <FormText
                      label="Part number"
                      value={row.part}
                      mono
                      suggestions={t.link.parts}
                      onChange={(v) => set(i, withPart(row, v, t.link.parts))}
                    />
                    <FormText
                      label="Length"
                      value={row.length}
                      inputMode="decimal"
                      onChange={(v) => set(i, { ...row, length: v })}
                    />
                    <FormSelect
                      label="Unit"
                      value={row.unit}
                      options={UNITS}
                      onChange={(v) => set(i, { ...row, unit: v ?? "m" })}
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <FormFooter
            onCancel={onClose}
            submitting={saving}
            submitLabel={many ? "Record all" : "Record"}
            submittingLabel="Recording…"
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
