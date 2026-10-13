#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const entry = join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts")
const result = spawnSync(process.execPath, ["--import", "tsx", entry, ...process.argv.slice(2)], {
  stdio: "inherit",
})
process.exit(result.status ?? 1)
