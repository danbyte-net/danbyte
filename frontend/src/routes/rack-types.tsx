import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/rack-types")({
  component: () => <Outlet />,
})
