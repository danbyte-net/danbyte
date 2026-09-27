import { useState } from "react"
import { useMutation } from "@tanstack/react-query"

import { ApiError } from "@/lib/api"
import type { TopologyViewSaved, TopologyViewState } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { PlanStaged, useSaveObject } from "@/lib/save-object"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field } from "@/components/forms/field"
import { Input } from "@/components/ui/input"
import { SegmentedTabs } from "@/components/segmented-tabs"

// New view: a saved view to build a Diagram in. "Blank" starts with no
// devices at all (the palette fills it); "This map" takes the devices the
// map shows now, as a fixed set, arranged as they stand. Either way the
// view is a hand-picked device set from then on - its filters no longer
// decide what is on it.

export type NewViewStart = "blank" | "map"

/** A view's device set cannot be larger (the graph endpoint's cap). */
export const MAX_VIEW_DEVICES = 10_000

const TAKEN = "A view with this name already exists."

export interface NewViewDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** How many devices "This map" would take; null when the map on screen
   * cannot become a device set (a map grouped by site or location). */
  mapCount: number | null
  /** The new view's saved state for each start. */
  stateFor: (start: NewViewStart) => TopologyViewState
  /** View names already in use. */
  taken?: readonly string[]
  onCreated: (view: TopologyViewSaved, start: NewViewStart) => void
}

export function NewViewDialog({
  open,
  onOpenChange,
  mapCount,
  stateFor,
  taken = [],
  onCreated,
}: NewViewDialogProps) {
  const [name, setName] = useState("")
  const [start, setStart] = useState<NewViewStart>("blank")
  const [error, setError] = useState<string | null>(null)

  const saveObject = useSaveObject()
  const create = useMutation({
    mutationFn: (a: { name: string; start: NewViewStart }) =>
      saveObject<TopologyViewSaved>({
        objectType: "api.topologyview",
        endpoint: "/api/topology-views/",
        payload: { name: a.name, state: stateFor(a.start) },
      }),
    onSuccess: (view, a) => {
      onCreated(view, a.start)
      setName("")
      setStart("blank")
      setError(null)
      onOpenChange(false)
    },
    onError: (err) => {
      if (err instanceof PlanStaged) return
      // A duplicate name is refused by the database (409) or, should the
      // serializer ever check it, as a field error.
      if (err instanceof ApiError && err.status === 409) setError(TAKEN)
      else if (
        err instanceof ApiError &&
        err.status === 400 &&
        err.body &&
        typeof err.body === "object" &&
        "name" in err.body
      ) {
        const v = err.body.name
        setError(Array.isArray(v) ? String(v[0]) : String(v))
      } else apiErrorToast(err)
    },
  })

  const trimmed = name.trim()
  const mapTooBig = mapCount !== null && mapCount > MAX_VIEW_DEVICES
  const mapBlocked = start === "map" && (mapCount === null || mapTooBig)
  const submit = () => {
    if (!trimmed || mapBlocked || create.isPending) return
    if (taken.includes(trimmed)) {
      setError(TAKEN)
      return
    }
    setError(null)
    create.mutate({ name: trimmed, start })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          setName("")
          setStart("blank")
          setError(null)
        }
        onOpenChange(o)
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>New view</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="grid gap-4"
        >
          <Field label="Name" error={error ?? undefined}>
            <Input
              autoFocus
              placeholder="Core row · dc1"
              value={name}
              aria-invalid={!!error || undefined}
              onChange={(e) => {
                setName(e.target.value)
                if (error) setError(null)
              }}
            />
          </Field>
          <Field
            label="Start from"
            info="Blank starts with no devices; add them from the Devices list. This map keeps the devices on screen now, where they stand."
          >
            <SegmentedTabs<NewViewStart>
              value={start}
              onValueChange={setStart}
              items={[
                { value: "blank", label: "Blank" },
                {
                  value: "map",
                  label: "This map",
                  count:
                    mapCount === null ? null : mapCount.toLocaleString("en"),
                },
              ]}
            />
            {start === "map" && mapCount === null && (
              <p className="text-xs text-muted-foreground">
                A grouped map cannot become a view of devices.
              </p>
            )}
            {start === "map" && mapTooBig && (
              <p className="text-xs text-muted-foreground">
                A view holds at most {MAX_VIEW_DEVICES.toLocaleString("en")}{" "}
                devices - narrow the filters first.
              </p>
            )}
          </Field>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!trimmed || mapBlocked || create.isPending}
            >
              {create.isPending ? "Creating..." : "Create"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
