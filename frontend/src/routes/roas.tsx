import { createFileRoute, Outlet } from "@tanstack/react-router"

export const Route = createFileRoute("/roas")({
  component: () => <Outlet />,
})
