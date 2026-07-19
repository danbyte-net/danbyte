import http from "node:http"
import httpProxy from "http-proxy"
const proxy = httpProxy.createProxyServer({ changeOrigin: true })
const PREVIEW = "http://localhost:3100"
const BACKEND = "http://localhost:8000"
const server = http.createServer((req, res) => {
  const url = req.url || "/"
  const goBackend =
    url.startsWith("/api") || url.startsWith("/auth") || url.startsWith("/admin") ||
    url.startsWith("/static") || url.startsWith("/django-rq")
  proxy.web(req, res, { target: goBackend ? BACKEND : PREVIEW })
})
server.listen(3200, () => console.log("proxy on :3200"))
