import { createFileRoute, redirect } from "@tanstack/react-router"

/** `/change-log` matches what the UI calls this page; `/audit-log` is the
 * original path and stays valid, so old links and bookmarks keep working.
 * Filters ride along through the redirect. */
export const Route = createFileRoute("/change-log")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/audit-log", search })
  },
})
