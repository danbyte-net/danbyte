import { createFileRoute, redirect } from "@tanstack/react-router"

/** Alias of `/audit-log/$id` - see change-log.tsx. */
export const Route = createFileRoute("/change-log_/$id")({
  beforeLoad: ({ params, search }) => {
    throw redirect({ to: "/audit-log/$id", params, search })
  },
})
