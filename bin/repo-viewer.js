#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const cliDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(cliDir, "..");

function printHelp() {
  console.log(`Repo Viewer

Usage:
  repo-viewer [root] [options]
  repo-viewer --root <path> --port 4173

Options:
  --root <path>     Local repository path to open. Defaults to current directory.
  --port <number>   Local web server port. Defaults to 4173.
  --check           Validate that the selected root can be scanned.
  --help            Show this help message.
  --version         Show package version.

Examples:
  npx @8865a/repo-viewer .
  npx @8865a/repo-viewer --root C:\\Files\\Code\\my-repo --port 4180
`);
}

function readOption(index) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${args[index]} requires a value.`);
  }
  return value;
}

let root = "";
let port = "";
const passthrough = [];

try {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    if (arg === "--version" || arg === "-v") {
      const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
      console.log(packageJson.version);
      process.exit(0);
    }
    if (arg === "--root") {
      root = readOption(index);
      index += 1;
      continue;
    }
    if (arg.startsWith("--root=")) {
      root = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--port" || arg === "-p") {
      port = readOption(index);
      index += 1;
      continue;
    }
    if (arg.startsWith("--port=")) {
      port = arg.slice("--port=".length);
      continue;
    }
    if (arg === "--check") {
      passthrough.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!root) {
      root = arg;
      continue;
    }
    throw new Error(`Unexpected argument: ${arg}`);
  }

  const repoRoot = resolve(process.cwd(), root || ".");
  if (!existsSync(repoRoot)) {
    throw new Error(`Repository path does not exist: ${repoRoot}`);
  }
  if (port && !/^\d+$/.test(port)) {
    throw new Error(`Port must be a number: ${port}`);
  }

  process.env.REPO_ROOT = repoRoot;
  if (port) process.env.PORT = port;
  if (!process.env.REPO_VIEWER_ENV_PATH) {
    process.env.REPO_VIEWER_ENV_PATH = resolve(process.cwd(), ".repo-viewer.env");
  }

  process.argv = [process.argv[0], resolve(packageRoot, "server/index.js"), ...passthrough];
  await import("../server/index.js");
} catch (error) {
  console.error(error.message || error);
  console.error("Run `repo-viewer --help` for usage.");
  process.exit(1);
}
