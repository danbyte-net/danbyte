import { createFileRoute, redirect } from "@tanstack/react-router"

/** Tenant and deployment monitoring are one page with a scope switch now
 * (#51). Kept so old links and bookmarks keep working. */
export const Route = createFileRoute("/settings/monitoring-defaults")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/monitoring",
      search: { scope: "deployment" },
    })
  },
})
