/** Whether Django answers for `name` under these ALLOWED_HOSTS patterns -
 * the rule of Django's `validate_host`: `*`, an exact name, or `.domain`
 * for the domain and every name under it. A port on the name is ignored.
 * With no patterns known the answer is yes: nothing to warn about. */
export function answersFor(name: string, allowed: string[]): boolean {
  const host = name.trim().toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "")
  if (!host || allowed.length === 0) return true
  return allowed.some((raw) => {
    const p = raw.trim().toLowerCase()
    if (p === "*") return true
    if (p.startsWith(".")) return host === p.slice(1) || host.endsWith(p)
    return host === p
  })
}
