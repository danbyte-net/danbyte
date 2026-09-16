import { createFileRoute, redirect } from "@tanstack/react-router"

/** Plugins are switches, and every switch lives on one page now (#51) -
 * installing and applying moved there with them, and Services moved to the
 * install page. This path stays valid so old links and bookmarks keep
 * working. */
export const Route = createFileRoute("/settings/plugins")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/integrations" })
  },
})
