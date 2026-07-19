import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/fhrp-groups")({
  component: () => <Outlet />,
})
