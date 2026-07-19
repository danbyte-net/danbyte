import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/vlan-groups")({
  component: () => <Outlet />,
})
