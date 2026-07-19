import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/tunnel-groups")({
  component: () => <Outlet />,
})
