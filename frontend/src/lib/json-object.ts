// JSON-object textareas (config-context data, local context data): the text
// a form edits, and that text read back as an object.

/** The text parsed: the object, `null` when blank, or `undefined` when it is
 * not a JSON object. */
export function parseJsonObject(
  text: string
): Record<string, unknown> | null | undefined {
  const t = text.trim()
  if (t === "") return null
  try {
    const v: unknown = JSON.parse(t)
    if (v !== null && typeof v === "object" && !Array.isArray(v))
      return v as Record<string, unknown>
  } catch {
    // not JSON: falls through
  }
  return undefined
}

/** An object as the textarea shows it; blank for none or an empty object. */
export function jsonObjectText(
  v: Record<string, unknown> | null | undefined
): string {
  return v && Object.keys(v).length ? JSON.stringify(v, null, 2) : ""
}
