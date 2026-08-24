// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const tempDir = mkdtempSync(join(tmpdir(), "wassette-inspector-browser."));
const componentDir = join(tempDir, "components");
const catalogPath = join(tempDir, "mcp-inspector.json");
const wassetteBin = process.env.WASSETTE_BIN ?? join(repoRoot, "bin/wassette");
const timeComponent =
  process.env.TIME_COMPONENT ??
  join(repoRoot, "examples/time-server-js/time.wasm");
const inspectorLauncher = join(
  testDir,
  "node_modules/@modelcontextprotocol/inspector/clients/launcher/build/index.js",
);
const inspectorCli = join(testDir, "node_modules/.bin/mcp-inspector");
const mcpUrl = "http://127.0.0.1:9001/mcp";
const inspectorUrl = "http://127.0.0.1:6274";
const token = `wassette-inspector-${process.pid}`;
const children = [];
let browser;

mkdirSync(componentDir);
copyFileSync(join(repoRoot, ".config/mcp-inspector.json"), catalogPath);

function start(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
  child.output = "";
  child.stdout.on("data", (chunk) => {
    child.output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    child.output += chunk;
  });
  children.push(child);
  return child;
}

async function waitForUrl(url, child, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before becoming ready:\n${child.output}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The process is still starting.
    }
    await delay(250);
  }
  throw new Error(`${label} did not become ready:\n${child.output}`);
}

async function run(command, args, label) {
  const child = start(command, args);
  const exitCode = await new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}:\n${child.output}`);
  }
  return child.output;
}

async function cleanup() {
  if (browser) {
    await browser.close().catch(() => {});
  }
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolveExit) => child.once("exit", resolveExit)),
        delay(5_000),
      ]);
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
}

try {
  const wassette = start(
    wassetteBin,
    [
      "serve",
      "--streamable-http",
      "--bind-address",
      "127.0.0.1:9001",
      "--component-dir",
      componentDir,
    ],
    { env: { ...process.env, RUST_LOG: "warn" } },
  );
  await waitForUrl("http://127.0.0.1:9001/ready", wassette, "Wassette");

  const inspector = start(process.execPath, [inspectorLauncher, "--web"], {
    env: {
      ...process.env,
      CLIENT_PORT: "6274",
      HOST: "127.0.0.1",
      MCP_INSPECTOR_API_TOKEN: token,
      MCP_CATALOG_PATH: catalogPath,
      MCP_AUTO_OPEN_ENABLED: "false",
    },
  });
  await waitForUrl(inspectorUrl, inspector, "MCP Inspector");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  const url = new URL(inspectorUrl);
  url.search = new URLSearchParams({
    serverUrl: mcpUrl,
    transport: "http",
    autoConnect: token,
  });
  await page.goto(url.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const status = page.locator('[data-testid="connection-status"]');
  await status.waitFor({ state: "attached", timeout: 30_000 });
  if ((await status.getAttribute("data-deeplink")) !== "parsed") {
    throw new Error(
      `Inspector rejected the deep link: ${await status.getAttribute("data-error-message")}`,
    );
  }
  await page
    .locator('[data-testid="connection-status"][data-status="connected"]')
    .waitFor({ state: "attached", timeout: 45_000 });
  await page.getByText("MCP 2026-07-28").waitFor({ timeout: 15_000 });
  await page
    .getByRole("heading", { name: "Tools" })
    .waitFor({ timeout: 15_000 });
  await page.getByPlaceholder("Search tools...").waitFor();

  if ((await page.getByText("get-current-time", { exact: true }).count()) !== 0) {
    throw new Error("time component was present before the subscription test");
  }

  const loadArguments = JSON.stringify({ path: timeComponent });
  await run(
    inspectorCli,
    [
      "--cli",
      "--config",
      catalogPath,
      "--server",
      "wassette-modern",
      "--method",
      "tools/call",
      "--tool-name",
      "load-component",
      "--tool-args-json",
      loadArguments,
      "--format",
      "json",
    ],
    "MCP Inspector component load",
  );

  await page.getByText("List updated").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Refresh" }).click();
  await page
    .getByText("get-current-time", { exact: true })
    .waitFor({ timeout: 30_000 });

  if (pageErrors.length > 0) {
    throw new Error(`Inspector page errors: ${pageErrors.join("; ")}`);
  }

  console.log(
    "MCP Inspector browser test passed: modern discovery, tools, and subscriptions/listen",
  );
} finally {
  await cleanup();
}
