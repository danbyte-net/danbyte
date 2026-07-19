import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/ip-roles")({
  component: () => <Outlet />,
})
