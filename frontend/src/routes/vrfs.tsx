import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/vrfs")({
  component: () => <Outlet />,
})
