import { useEffect, useState } from "react"

import type { PrtgDeviceLink } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { FormCheckbox } from "@/components/forms"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

import { usePrtgEnabled } from "./group-picker"
import { usePrtgLinks } from "./sensors-tab"
import type { PrtgParent } from "./sensors-tab"

export { prtgDeleteToast } from "./delete-toast"

/** What a delete does in PRTG: the `?prtg=` mode and `prtg_force`. */
export interface PrtgDeleteChoice {
  mode: "keep" | "remove" | "pause"
  force: boolean
}

export const KEEP_IN_PRTG: PrtgDeleteChoice = { mode: "keep", force: false }

/** The delete URL's query for a choice: "" for keep. */
export function prtgDeleteQuery(choice: PrtgDeleteChoice): string {
  if (choice.mode === "keep") return ""
  const qs = new URLSearchParams({ prtg: choice.mode })
  if (choice.force) qs.set("prtg_force", "1")
  return `?${qs.toString()}`
}

/** Whether the user may change PRTG devices: the integration is on and
 * they hold change on PRTG device links. */
export function useCanWritePrtg(): boolean {
  const enabled = usePrtgEnabled()
  const { canDo } = useMe()
  return enabled && canDo("prtgdevicelink", "change")
}

/**
 * "Also remove from PRTG" for one device's or VM's delete dialog. Shown
 * only when the object is linked in PRTG and the user may write there. A
 * PRTG device Danbyte did not create is paused instead, unless "Delete it
 * anyway" is picked and confirmed by name. `onChange` gets the choice, and
 * `ready` false while a "Delete it anyway" waits for its confirmation.
 */
export function PrtgDeleteOption({
  parent,
  onChange,
}: {
  parent: PrtgParent | null
  onChange: (choice: PrtgDeleteChoice, ready: boolean) => void
}) {
  const canWrite = useCanWritePrtg()
  const links = usePrtgLinks(parent ?? { device: "" }, !!parent && canWrite)
  const rows = links.data ?? []
  const show = !!parent && canWrite && rows.length > 0
  // Nothing to offer: the delete keeps PRTG as it is.
  useEffect(() => {
    if (!show) onChange(KEEP_IN_PRTG, true)
  }, [show, onChange])
  if (!show) return null
  return <Choice key={rowsKey(rows)} links={rows} onChange={onChange} />
}

const rowsKey = (rows: PrtgDeviceLink[]) => rows.map((r) => r.id).join(",")

function Choice({
  links,
  onChange,
}: {
  links: PrtgDeviceLink[]
  onChange: (choice: PrtgDeleteChoice, ready: boolean) => void
}) {
  const others = links.filter((l) => !l.created_here)
  const [remove, setRemove] = useState(() =>
    links.some((l) => l.delete_default_remove)
  )
  const [anyway, setAnyway] = useState(false)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    if (!remove) onChange(KEEP_IN_PRTG, true)
    else if (others.length === 0)
      onChange({ mode: "remove", force: false }, true)
    else if (anyway) onChange({ mode: "remove", force: true }, confirmed)
    else onChange({ mode: "remove", force: false }, true)
  }, [remove, anyway, confirmed, others.length, onChange])

  const names = others.map((l) => `${l.name || l.objid} (${l.objid})`)
  return (
    <div className="space-y-2 text-xs" data-testid="prtg-delete-option">
      <FormCheckbox
        label="Also remove from PRTG"
        checked={remove}
        onChange={setRemove}
      />
      {remove && others.length > 0 && (
        <div className="space-y-2 pl-6">
          <p className="text-muted-foreground">
            Not created by Danbyte: {names.join(", ")}
          </p>
          <RadioGroup
            value={anyway ? "delete" : "pause"}
            onValueChange={(v) => {
              setAnyway(v === "delete")
              setConfirmed(false)
            }}
          >
            <Label className="flex items-center gap-2 text-xs font-normal whitespace-nowrap">
              <RadioGroupItem value="pause" />
              Pause in PRTG instead
            </Label>
            <Label className="flex items-center gap-2 text-xs font-normal whitespace-nowrap">
              <RadioGroupItem value="delete" />
              Delete it anyway
            </Label>
          </RadioGroup>
          {anyway && (
            <FormCheckbox
              label={`Delete ${names.join(", ")} in PRTG`}
              checked={confirmed}
              onChange={setConfirmed}
            />
          )}
        </div>
      )}
    </div>
  )
}
