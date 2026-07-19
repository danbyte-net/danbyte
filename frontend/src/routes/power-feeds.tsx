import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/power-feeds")({
  component: () => <Outlet />,
})
