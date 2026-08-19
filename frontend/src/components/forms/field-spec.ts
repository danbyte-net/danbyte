import type { DcimChoice, DcimChoices } from "@/lib/api"

// The declarative description of an editable field, shared by every consumer
// of <FieldEditor/>: the component bulk-edit dialog (which authors these specs
// by hand, per table) and any single-object editor driven by the server's
// editable-field list. One spec shape → one editor implementation.

/** Keys of `/api/dcim/choices/` that hold a selectable option list. */
export type DcimChoiceListKey = {
  [K in keyof DcimChoices]: DcimChoices[K] extends DcimChoice[] ? K : never
}[keyof DcimChoices]

// A union, not a flat interface: `choices` is required when kind is "choice",
// so a choice-backed field can't be declared without saying where its options
// come from (which is how they used to silently render as text boxes).
export type BulkFieldSpec =
  | {
      key: string
      label: string
      kind: "text" | "int" | "bool" | "vlan" | "vrf"
      /** Common values offered as a dropdown; the field stays free text. */
      suggestions?: string[]
      hint?: string
    }
  | {
      key: string
      label: string
      kind: "choice"
      /** Which `/api/dcim/choices/` list populates the dropdown. */
      choices: DcimChoiceListKey
      hint?: string
    }
  | {
      key: string
      label: string
      /** A caller-supplied static option list (model choices without a
       * /api/dcim/choices/ entry - inventory kind/media etc.). */
      kind: "options"
      options: { value: string; label: string }[]
      hint?: string
    }
  | {
      key: string
      label: string
      /** The tenant Status catalog, filtered to one object type. Sends the
       * status id (or null to clear). */
      kind: "status"
      statusModel: string
      hint?: string
    }
  | {
      key: string
      label: string
      /** A byte quantity entered as value + KB…PB unit (stored as bytes). */
      kind: "bytes"
      hint?: string
    }
  | {
      key: string
      label: string
      /** Any object from the customization reference registry - a site, rack,
       *  device, status-bearing catalog row. Rendered with CfObjectPicker. */
      kind: "object"
      /** Reference-registry slug ("site", "rack"), used to look up refMeta. */
      object_model: string
      hint?: string
    }

/**
 * The wire shape of one row from `GET /api/editable-fields/?model=<slug>` -
 * the server telling the SPA which fields of a model are editable and how to
 * render each one, so a single-object editor needs no hand-authored spec.
 *
 * Flat and permissive on purpose: it is untrusted server data, so every
 * kind-specific attribute is optional here. Narrow it to the matching
 * `BulkFieldSpec` variant at the boundary (a payload claiming
 * `kind: "choice"` without `choices` is a backend bug, not a text field), and
 * <FieldEditor/> then renders both sources through the same switch.
 */
export interface EditableFieldSpec {
  key: string
  label: string
  kind:
    | "text"
    | "int"
    | "bool"
    | "choice"
    | "options"
    | "status"
    | "bytes"
    | "vlan"
    | "vrf"
    | "object"
  nullable: boolean
  hint?: string
  /** Key into `/api/dcim/choices/`. */
  choices?: DcimChoiceListKey
  options?: { value: string; label: string; group?: string }[]
  suggestions?: string[]
  status_model?: string
  object_model?: string
  endpoint?: string
  picker?: boolean
}
