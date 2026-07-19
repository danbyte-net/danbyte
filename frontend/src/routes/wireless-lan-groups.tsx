import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/wireless-lan-groups")({
  component: () => <Outlet />,
})
