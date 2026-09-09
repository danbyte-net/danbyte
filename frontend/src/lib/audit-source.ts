/** How a change reached Danbyte, as shown in the change log's Via column.
 *
 * The source never replaces the user: an assistant write is still attributed
 * to the person who asked for it, because it runs with their access.
 */
export const VIA_LABEL: Record<string, string> = {
  ui: "UI",
  api: "API",
  chat: "Assistant",
  system: "System",
}

export const VIA_OPTIONS = [
  { value: "all", label: "All sources" },
  ...Object.entries(VIA_LABEL).map(([value, label]) => ({ value, label })),
]
