import { createFileRoute, redirect } from "@tanstack/react-router"

/** Merged into `/settings/directory` with a scope switch (#51). Kept so old
 * links and bookmarks keep working. */
export const Route = createFileRoute("/settings/tenant-ldap")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/directory", search: { scope: "tenant" } })
  },
})
