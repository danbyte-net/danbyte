import { createFileRoute, redirect } from "@tanstack/react-router"

/** The deployment and tenant directories are one page with a scope switch
 * now (#51). This path stays valid so old links and bookmarks keep working. */
export const Route = createFileRoute("/settings/ldap")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/directory",
      search: { scope: "deployment" },
    })
  },
})
