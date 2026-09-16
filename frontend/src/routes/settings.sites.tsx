import { createFileRoute, redirect } from "@tanstack/react-router"

/** Site separation is one page with a scope switch now (#51). Kept so old
 * links and bookmarks keep working. */
export const Route = createFileRoute("/settings/sites")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/separation",
      search: { scope: "deployment" },
    })
  },
})
