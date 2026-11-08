// The configuration scopes, on their own: the monitoring route's
// validateSearch reads them, and it runs in the main bundle, so importing
// them from the panels' module would pull every panel (and the icon map
// they use) into every page (#488).
export const CONFIG_TABS = [
  "global",
  "regions",
  "sites",
  "prefixes",
  "platforms",
  "types",
  "roles",
  "devices",
  "deny",
] as const
export type ConfigTab = (typeof CONFIG_TABS)[number]
