import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Script } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { SettingsCard } from "@/components/settings/settings-card"
import {
  CadenceFields,
  DEFAULT_CADENCE,
  RetentionFields,
} from "@/components/settings/cadence-fields"
import { Field } from "@/components/forms/field"
import { FormCheckbox } from "@/components/forms/checkbox"
import { TimeCell } from "@/components/cells/time-ago"
import { Button } from "@/components/ui/button"

/** Why an enabled schedule skips its runs; empty when it runs. */
type ScheduleState = Script & { schedule_blocked?: string }

/** When the script runs by itself, and how many runs are kept. Only the
 *  owner edits it (`canEdit`); anyone else who may change the script can
 *  still turn it off (`canStop`). */
export function ScriptSchedulePanel({
  script,
  canEdit,
  canStop = false,
}: {
  script: Script
  canEdit: boolean
  canStop?: boolean
}) {
  const qc = useQueryClient()
  const blocked = (script as ScheduleState).schedule_blocked
  const [enabled, setEnabled] = useState(script.schedule_enabled)
  const [cadence, setCadence] = useState(
    script.schedule_enabled ? script.cadence : DEFAULT_CADENCE
  )
  const [retention, setRetention] = useState(script.retention)

  const save = useMutation({
    mutationFn: () =>
      api<Script>(`/api/scripts/${script.id}/`, {
        method: "PATCH",
        body: JSON.stringify({
          schedule_enabled: enabled,
          cadence: enabled ? cadence : {},
          retention,
        }),
      }),
    onSuccess: () => {
      toast.success("Schedule saved")
      void qc.invalidateQueries({ queryKey: ["script", script.id] })
      void qc.invalidateQueries({ queryKey: ["scripts"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  const stop = useMutation({
    mutationFn: () =>
      api<Script>(`/api/scripts/${script.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ schedule_enabled: false }),
      }),
    onSuccess: () => {
      toast.success("Schedule turned off")
      setEnabled(false)
      void qc.invalidateQueries({ queryKey: ["script", script.id] })
      void qc.invalidateQueries({ queryKey: ["scripts"] })
    },
    onError: (e) => apiErrorToast(e),
  })

  return (
    <SettingsCard
      title="Schedule"
      description="A scheduled run uses the owner's access and any parameters saved here."
      onSave={canEdit ? () => save.mutate() : undefined}
      saving={save.isPending}
      dirty
    >
      <FormCheckbox
        label="Run on a schedule"
        checked={enabled}
        onChange={setEnabled}
        disabled={!canEdit}
      />
      {script.schedule_enabled && blocked && (
        <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <span>Runs are skipped. {blocked}</span>
        </div>
      )}
      {!canEdit && canStop && script.schedule_enabled && (
        <div>
          <Button
            size="sm"
            variant="outline"
            disabled={stop.isPending}
            onClick={() => stop.mutate()}
          >
            {stop.isPending ? "Turning off…" : "Turn off schedule"}
          </Button>
        </div>
      )}
      {enabled && (
        <>
          <CadenceFields value={cadence} onChange={setCadence} />
          {script.next_run_at && (
            <p className="text-xs text-muted-foreground">
              Next run <TimeCell iso={script.next_run_at} />
            </p>
          )}
        </>
      )}
      <Field
        label="Keep runs"
        hint="Older runs and their files are deleted after each scheduled run."
      >
        <RetentionFields value={retention} onChange={setRetention} />
      </Field>
    </SettingsCard>
  )
}
