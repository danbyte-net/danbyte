import { createFileRoute, redirect } from "@tanstack/react-router"

// Legacy URL — the page was renamed: statuses cover every model, not just
// IPs. Old bookmarks land here and bounce to the new home.
export const Route = createFileRoute("/ip-statuses")({
  beforeLoad: () => {
    throw redirect({ to: "/statuses" })
  },
})
