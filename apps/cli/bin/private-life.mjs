#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)
const tsx = require.resolve("tsx/dist/cli.mjs")
const entry = join(dirname(fileURLToPath(import.meta.url)), "../src/main.ts")
const result = spawnSync(process.execPath, [tsx, entry, ...process.argv.slice(2)], { stdio: "inherit" })
process.exit(result.status ?? 1)
