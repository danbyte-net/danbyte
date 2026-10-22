/** Paths Django serves itself (the admin and the job queue). After sign-in
 * they need a real page load; the router knows nothing about them. */
const SERVER_PATHS = ["/admin/", "/django-rq/"]

/** Where to go after sign-in: a path on this site only, never another host
 * (`//host` or `/\host` read as one in a browser). */
export function safeRedirect(redirect: string | undefined): string {
  if (!redirect || !redirect.startsWith("/")) return "/"
  if (redirect.startsWith("//") || redirect.startsWith("/\\")) return "/"
  return redirect
}

export function isServerPath(path: string): boolean {
  return SERVER_PATHS.some((p) => path.startsWith(p))
}
