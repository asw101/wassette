// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { spawn } from "node:child_process";
import {
  readFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

function requestedPort(value, name) {
  if (value === undefined) return 0;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be an integer from 1 through 65535`);
  }
  return port;
}

async function reservePorts(requestedPorts) {
  const servers = [];
  try {
    for (const requested of requestedPorts) {
      const server = createServer();
      await new Promise((resolveListen, rejectListen) => {
        server.once("error", rejectListen);
        server.listen(requested, "127.0.0.1", resolveListen);
      });
      servers.push(server);
    }
    return servers.map((server) => server.address().port);
  } finally {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise((resolveClose) => server.close(resolveClose)),
      ),
    );
  }
}

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "../..");
const [wassettePort, inspectorPort] = await reservePorts([
  requestedPort(process.env.WASSETTE_PORT, "WASSETTE_PORT"),
  requestedPort(process.env.INSPECTOR_PORT, "INSPECTOR_PORT"),
]);
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
const mcpUrl = `http://127.0.0.1:${wassettePort}/mcp`;
const inspectorUrl = `http://127.0.0.1:${inspectorPort}`;
const token = `wassette-inspector-${process.pid}`;
const children = [];
let browser;

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
  child.spawnError = undefined;
  child.once("error", (error) => {
    child.spawnError = error;
  });
  children.push(child);
  return child;
}

async function waitForUrl(url, child, label) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.spawnError) {
      throw new Error(`${label} failed to start: ${child.spawnError.message}`);
    }
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

function isRunning(child) {
  return (
    child.spawnError === undefined &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

async function waitForExit(child, timeout) {
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  if (!isRunning(child)) return true;
  await Promise.race([exited, delay(timeout)]);
  return !isRunning(child);
}

async function stop(child) {
  if (!isRunning(child)) return;
  child.kill("SIGTERM");
  if (await waitForExit(child, 5_000)) return;

  child.kill("SIGKILL");
  if (!(await waitForExit(child, 5_000))) {
    throw new Error(`could not stop child process ${child.pid}`);
  }
}

async function cleanup() {
  const errors = [];
  if (browser) {
    try {
      await browser.close();
    } catch (error) {
      errors.push(error);
    }
  }
  for (const child of children.reverse()) {
    try {
      await stop(child);
    } catch (error) {
      errors.push(error);
    }
  }
  rmSync(tempDir, { recursive: true, force: true });
  if (errors.length > 0) {
    throw new AggregateError(errors, "failed to clean up MCP Inspector processes");
  }
}

async function testInspector() {
  mkdirSync(componentDir);
  const catalog = JSON.parse(
    readFileSync(join(repoRoot, ".config/mcp-inspector.json"), "utf8"),
  );
  for (const server of Object.values(catalog.mcpServers)) {
    if (server.type === "http") server.url = mcpUrl;
  }
  writeFileSync(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);

  const wassette = start(
    wassetteBin,
    [
      "serve",
      "--streamable-http",
      "--bind-address",
      `127.0.0.1:${wassettePort}`,
      "--component-dir",
      componentDir,
    ],
    { env: { ...process.env, RUST_LOG: "warn" } },
  );
  await waitForUrl(
    `http://127.0.0.1:${wassettePort}/ready`,
    wassette,
    "Wassette",
  );

  const inspector = start(process.execPath, [inspectorLauncher, "--web"], {
    env: {
      ...process.env,
      CLIENT_PORT: String(inspectorPort),
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
  const browserDiagnostics = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (["error", "warning"].includes(message.type())) {
      browserDiagnostics.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("requestfailed", (request) => {
    browserDiagnostics.push(
      `request failed: ${request.method()} ${request.url()}: ${request.failure()?.errorText}`,
    );
  });

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
  try {
    await page
      .locator('[data-testid="connection-status"][data-status="connected"]')
      .waitFor({ state: "attached", timeout: 45_000 });
  } catch (error) {
    const statusValue = await status
      .getAttribute("data-status")
      .catch((statusError) => `unavailable: ${statusError.message}`);
    const connectionError = await status
      .getAttribute("data-error-message")
      .catch((statusError) => `unavailable: ${statusError.message}`);
    throw new Error(
      [
        error.message,
        `connection status: ${statusValue}`,
        `connection error: ${connectionError}`,
        `Inspector output:\n${inspector.output}`,
        `Browser diagnostics:\n${browserDiagnostics.join("\n")}`,
      ].join("\n"),
    );
  }
  await page.getByText("MCP 2026-07-28").waitFor({ timeout: 15_000 });
  await page.getByText("Tools", { exact: true }).first().click();
  try {
    await page.getByPlaceholder("Search tools...").waitFor();
  } catch (error) {
    const pageText = await page
      .locator("body")
      .innerText()
      .catch((pageError) => `unavailable: ${pageError.message}`);
    throw new Error(
      `${error.message}\nInspector page:\n${pageText.slice(0, 8_000)}`,
    );
  }

  if ((await page.getByText(/get-current-time$/).count()) !== 0) {
    throw new Error("time component was present before the subscription test");
  }
  const listUpdated = page.getByText("List updated", { exact: true });
  if (await listUpdated.isVisible()) {
    throw new Error("Inspector showed a stale list update before the component load");
  }

  const loadArguments = JSON.stringify({
    path: pathToFileURL(timeComponent).href,
  });
  const loadOutput = await run(
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
  const loadResult = JSON.parse(loadOutput);
  if (
    loadResult.result?.isError === true ||
    !Array.isArray(loadResult.result?.content) ||
    loadResult.result.content.length === 0
  ) {
    throw new Error(`component load returned an invalid result: ${loadOutput}`);
  }
  const loadDetails = JSON.parse(loadResult.result.content[0].text);
  const timeToolName = loadDetails.tools?.[0];
  if (typeof timeToolName !== "string" || timeToolName.length === 0) {
    throw new Error(`component load returned no tool name: ${loadOutput}`);
  }

  await listUpdated.waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Refresh" }).click();
  await page
    .getByText(timeToolName, { exact: true })
    .waitFor({ timeout: 30_000 });

  if (pageErrors.length > 0) {
    throw new Error(`Inspector page errors: ${pageErrors.join("; ")}`);
  }

  console.log(
    "MCP Inspector browser test passed: modern discovery, tools, and subscriptions/listen",
  );
}

let rejectSignal;
const signalPromise = new Promise((_, reject) => {
  rejectSignal = reject;
});
const signalHandlers = new Map();
for (const signal of ["SIGINT", "SIGTERM"]) {
  const handler = () => rejectSignal(new Error(`received ${signal}`));
  signalHandlers.set(signal, handler);
  process.once(signal, handler);
}

try {
  await Promise.race([testInspector(), signalPromise]);
} finally {
  for (const [signal, handler] of signalHandlers) {
    process.removeListener(signal, handler);
  }
  await cleanup();
}
