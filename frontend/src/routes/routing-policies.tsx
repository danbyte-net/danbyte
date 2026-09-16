import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/routing-policies")({
  component: () => <Outlet />,
})
