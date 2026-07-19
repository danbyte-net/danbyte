import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/devices")({
  component: () => <Outlet />,
})
