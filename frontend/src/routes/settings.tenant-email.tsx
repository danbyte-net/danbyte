import { createFileRoute, redirect } from "@tanstack/react-router"

/** Deployment, tenant and site email are one page with a scope switch now
 * (#51). Kept so old links and bookmarks keep working. */
export const Route = createFileRoute("/settings/tenant-email")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/email", search: { scope: "tenant" } })
  },
})
