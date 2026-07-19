import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/device-types")({
  component: () => <Outlet />,
})
