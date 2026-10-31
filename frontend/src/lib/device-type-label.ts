/** A device type's display text. The name is required by the API, but an
 * imported row can still carry an empty one, and a link with no text has no
 * name a screen reader can announce (#461). Falls back to the model, then to
 * a placeholder. */
export function deviceTypeLabel(dt: { name: string; model?: string }): string {
  return dt.name.trim() || dt.model?.trim() || "Unnamed device type"
}
