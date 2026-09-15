import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/bgp-sessions")({
  component: () => <Outlet />,
})
