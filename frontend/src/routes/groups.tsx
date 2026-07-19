import { createFileRoute, Outlet } from "@tanstack/react-router"
export const Route = createFileRoute("/groups")({ component: () => <Outlet /> })
