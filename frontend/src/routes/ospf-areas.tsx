import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/ospf-areas")({
  component: () => <Outlet />,
})
