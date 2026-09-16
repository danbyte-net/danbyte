import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/bgp-peer-groups")({
  component: () => <Outlet />,
})
