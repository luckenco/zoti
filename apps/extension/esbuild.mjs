import { build } from "esbuild"
import { cp, mkdir } from "node:fs/promises"

await mkdir("dist", { recursive: true })
await build({
  entryPoints: ["src/popup.ts", "src/options.ts"],
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  platform: "browser",
  logLevel: "info",
})
await cp("src/manifest.json", "dist/manifest.json")
await cp("src/popup.html", "dist/popup.html")
await cp("src/options.html", "dist/options.html")
