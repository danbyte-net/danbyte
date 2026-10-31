import { createContext, useContext, useMemo } from "react"
import type { ReactNode } from "react"

// The link between a form Field's visible label and the control it labels
// (#428). `Field` provides one per field; the shared controls (Input,
// Textarea, SelectTrigger, Combobox, Checkbox, Switch, the pickers) read it
// and take the id the label's `htmlFor` points at, plus the hint/error
// description and the invalid state. Outside a Field the context is null and
// the controls render exactly as before.
export interface FieldControl {
  /** The id the label's `htmlFor` targets. */
  id: string
  /** Id of the <label> itself, for `aria-labelledby`. */
  labelId: string
  /** Space-separated ids of the hint and error lines, when shown. */
  describedBy?: string
  invalid: boolean
}

export const FieldControlContext = createContext<FieldControl | null>(null)

export function useFieldControl(): FieldControl | null {
  return useContext(FieldControlContext)
}

/** Cuts the link for everything inside: popover/dialog/menu content portals
 * out of the field visually but not in the React tree, and its search box
 * must not take the field's id. Also for self-labelled controls (a checkbox
 * inside its own <label>) and secondary controls beside the primary one. */
export function NoFieldControl({ children }: { children: ReactNode }) {
  return (
    <FieldControlContext.Provider value={null}>
      {children}
    </FieldControlContext.Provider>
  )
}

/** Names the one control inside by a caption that is not a <label> - a
 * filter rail heading, a popover field's small caps (#461). `labelId` is the
 * caption element's id; the control takes `${labelId}-control`. */
export function CaptionControl({
  labelId,
  children,
}: {
  labelId: string
  children: ReactNode
}) {
  const value = useMemo<FieldControl>(
    () => ({ id: `${labelId}-control`, labelId, invalid: false }),
    [labelId]
  )
  return (
    <FieldControlContext.Provider value={value}>
      {children}
    </FieldControlContext.Provider>
  )
}

interface AriaProps {
  id?: string
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean | "true" | "false" | "grammar" | "spelling"
}

/**
 * Merges the surrounding Field's link into a control's props. Anything the
 * caller set explicitly wins. `withOwnText` names a button-style trigger by
 * the label followed by its own text ("Status Active"), so the chosen value
 * is still announced.
 */
export function useFieldControlProps<TProps extends AriaProps>(
  props: TProps,
  { withOwnText = false }: { withOwnText?: boolean } = {}
): TProps {
  const field = useFieldControl()
  if (!field) return props
  const id = props.id ?? field.id
  const named =
    props["aria-label"] !== undefined || props["aria-labelledby"] !== undefined
  const describedBy =
    [props["aria-describedby"], field.describedBy].filter(Boolean).join(" ") ||
    undefined
  return {
    ...props,
    id,
    "aria-labelledby": named
      ? props["aria-labelledby"]
      : withOwnText
        ? `${field.labelId} ${id}`
        : field.labelId,
    "aria-describedby": describedBy,
    "aria-invalid": props["aria-invalid"] ?? (field.invalid || undefined),
  }
}
