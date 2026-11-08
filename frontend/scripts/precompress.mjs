// Writes a .gz beside each compressible file of the built client bundle, so
// nginx's gzip_static sends it as it is instead of compressing on every
// request (#485). Node's own zlib: no build plugin, no new dependency.
//
//   node scripts/precompress.mjs [dir]     (default dist/client/assets)
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

const dir = path.resolve(process.argv[2] ?? "dist/client/assets")
// The types nginx's gzip_types names for /assets/; fonts (woff2) and images
// are compressed already.
const COMPRESSIBLE = /\.(js|mjs|css|svg|json|wasm|map|txt|html)$/
// Below this a gzip header costs more than it saves (nginx's gzip_min_length).
const MIN_SIZE = 1024

if (!fs.existsSync(dir)) {
  console.error(`precompress: no ${dir} - run vite build first`)
  process.exit(1)
}

let files = 0
let before = 0
let after = 0
for (const entry of fs.readdirSync(dir, { recursive: true })) {
  const file = path.join(dir, String(entry))
  if (!COMPRESSIBLE.test(file)) continue
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size < MIN_SIZE) continue
  const gz = zlib.gzipSync(fs.readFileSync(file), { level: 9 })
  // A file that does not shrink is served as it is.
  if (gz.length >= stat.size) continue
  fs.writeFileSync(`${file}.gz`, gz)
  // Same mtime as the original, as gzip -k leaves it.
  fs.utimesSync(`${file}.gz`, stat.atime, stat.mtime)
  files += 1
  before += stat.size
  after += gz.length
}
const mb = (n) => (n / 1024 / 1024).toFixed(1)
console.log(
  `precompress: ${files} files, ${mb(before)} MB -> ${mb(after)} MB gzip`
)
