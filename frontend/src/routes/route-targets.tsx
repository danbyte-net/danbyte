import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/route-targets")({
  component: () => <Outlet />,
})
