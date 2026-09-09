import { createFileRoute, redirect } from "@tanstack/react-router"

/** Per-site email moved onto the merged Email page as a scope (#51). Kept so
 * old links and bookmarks keep working. */
export const Route = createFileRoute("/settings/site")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/email", search: { scope: "site" } })
  },
})
