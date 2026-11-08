import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/policy-rules")({
  component: () => <Outlet />,
})
