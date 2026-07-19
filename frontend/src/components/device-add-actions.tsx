import { createContext, useContext, useEffect, useRef } from "react"

/** One "add" affordance a pane wants surfaced in the Components sub-tab bar. */
export type AddAction = {
  label: string
  onClick: () => void
  disabled?: boolean
}

type Register = (key: string, actions: AddAction[]) => void

export const AddActionsContext = createContext<Register | null>(null)

/** The DOM node of the Components sub-tab bar's right-aligned action area. A
 * pane with a richer toolbar (Interfaces: Sync / Connect / Bulk / Add) portals
 * its buttons here so they sit in the bar instead of a separate row. */
export const BarSlotContext = createContext<HTMLElement | null>(null)

/**
 * Let a Components sub-pane publish its "add" actions to the shared sub-tab bar
 * (right-aligned), instead of scattering a button on every section header. The
 * parent (`DeviceComponents`) collects every mounted pane's actions and renders
 * them as a single contextual "Add" control.
 *
 * `key` must be stable per pane; `actions` may change identity each render —
 * only their labels/disabled flags drive re-registration, and the latest
 * click handlers are always invoked.
 */
export function useRegisterAddActions(key: string, actions: AddAction[]) {
  const register = useContext(AddActionsContext)
  const latest = useRef(actions)
  latest.current = actions
  const signature = actions
    .map((a) => `${a.label}:${a.disabled ? 0 : 1}`)
    .join("|")
  useEffect(() => {
    if (!register) return
    register(
      key,
      latest.current.map((a, i) => ({
        label: a.label,
        disabled: a.disabled,
        onClick: () => latest.current[i]?.onClick(),
      }))
    )
    return () => register(key, [])
  }, [register, key, signature])
}
