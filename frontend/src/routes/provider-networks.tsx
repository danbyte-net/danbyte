import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/provider-networks")({
  component: () => <Outlet />,
})
