import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/static-routes")({
  component: () => <Outlet />,
})
