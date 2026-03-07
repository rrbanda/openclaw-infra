import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { v4 as uuid } from "uuid";
import type {
  Deployer,
  DeployConfig,
  DeployResult,
  LogCallback,
} from "./types.js";

const execFileAsync = promisify(execFile);
import {
  detectRuntime,
  removeContainer,
  removeVolume,
  OPENCLAW_LABELS,
  type ContainerRuntime,
} from "../services/container.js";

const DEFAULT_IMAGE = "quay.io/sallyom/openclaw:latest";
const DEFAULT_PORT = 18789;

function containerName(config: DeployConfig): string {
  return `openclaw-${config.prefix}-${config.agentName}`.toLowerCase();
}

function volumeName(config: DeployConfig): string {
  return `openclaw-${config.prefix}-data`;
}

function runCommand(
  cmd: string,
  args: string[],
  log: LogCallback,
): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    log(`$ ${cmd} ${args.join(" ")}`);
    const proc = spawn(cmd, args);
    proc.stdout.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line) log(line);
      }
    });
    proc.stderr.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n")) {
        if (line) log(line);
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) => resolve({ code: code ?? 1 }));
  });
}

/**
 * Build the podman/docker run args for a given config.
 * Used by both deploy() and start() since --rm means
 * stop removes the container — start must re-create it.
 */
function buildRunArgs(config: DeployConfig, name: string, port: number): string[] {
  const runArgs = [
    "run",
    "-d",
    "--rm",
    "--name",
    name,
    "--network", "host",
    "--label", OPENCLAW_LABELS.managed,
    "--label", OPENCLAW_LABELS.prefix(config.prefix),
    "--label", OPENCLAW_LABELS.agent(config.agentName),
  ];

  const env: Record<string, string> = {
    HOME: "/home/node",
    NODE_ENV: "production",
  };

  if (config.anthropicApiKey) {
    env.ANTHROPIC_API_KEY = config.anthropicApiKey;
  }
  if (config.modelEndpoint) {
    env.MODEL_ENDPOINT = config.modelEndpoint;
  }
  if (config.vertexEnabled) {
    env.VERTEX_ENABLED = "true";
    env.VERTEX_PROVIDER = config.vertexProvider || "google";
    if (config.googleCloudProject) {
      env.GOOGLE_CLOUD_PROJECT = config.googleCloudProject;
    }
    if (config.googleCloudLocation) {
      env.GOOGLE_CLOUD_LOCATION = config.googleCloudLocation;
    }
  }

  for (const [key, val] of Object.entries(env)) {
    runArgs.push("-e", `${key}=${val}`);
  }

  runArgs.push("-v", `${volumeName(config)}:/home/node/.openclaw`);
  runArgs.push(DEFAULT_IMAGE);

  return runArgs;
}

export class LocalDeployer implements Deployer {
  async deploy(config: DeployConfig, log: LogCallback): Promise<DeployResult> {
    const id = uuid();
    const port = config.port ?? DEFAULT_PORT;
    const name = containerName(config);

    const runtime = config.containerRuntime ?? (await detectRuntime());
    if (!runtime) {
      throw new Error(
        "No container runtime found. Install podman or docker first.",
      );
    }
    log(`Using container runtime: ${runtime}`);

    // Remove existing container with same name (in case --rm didn't fire)
    await removeContainer(runtime, name);

    log(`Pulling ${DEFAULT_IMAGE}...`);
    const pull = await runCommand(runtime, ["pull", DEFAULT_IMAGE], log);
    if (pull.code !== 0) {
      throw new Error("Failed to pull image");
    }

    const runArgs = buildRunArgs(config, name, port);

    log(`Starting OpenClaw container: ${name}`);
    const run = await runCommand(runtime, runArgs, log);
    if (run.code !== 0) {
      throw new Error("Failed to start container");
    }

    log(`OpenClaw running at http://localhost:${port}`);

    // Extract and save gateway token to host filesystem
    await this.saveInstanceInfo(runtime, name, config, log);

    return {
      id,
      mode: "local",
      status: "running",
      config: { ...config, containerRuntime: runtime },
      startedAt: new Date().toISOString(),
      url: `http://localhost:${port}`,
      containerId: name,
    };
  }

  async start(result: DeployResult, log: LogCallback): Promise<DeployResult> {
    const runtime = result.config.containerRuntime ?? "podman";
    const name = result.containerId ?? containerName(result.config);
    const port = result.config.port ?? DEFAULT_PORT;

    // --rm means container was removed on stop, so we re-create it
    // The volume still has all the state
    log(`Starting OpenClaw container: ${name}`);
    const runArgs = buildRunArgs(result.config, name, port);
    const run = await runCommand(runtime, runArgs, log);
    if (run.code !== 0) {
      throw new Error("Failed to start container");
    }

    const url = `http://localhost:${port}`;
    log(`OpenClaw running at ${url}`);

    await this.saveInstanceInfo(runtime, name, result.config, log);

    return { ...result, status: "running", url };
  }

  async status(result: DeployResult): Promise<DeployResult> {
    const runtime = result.config.containerRuntime ?? "podman";
    const name = result.containerId ?? containerName(result.config);
    try {
      const { stdout } = await execFileAsync(runtime, [
        "inspect",
        "--format",
        "{{.State.Status}}",
        name,
      ]);
      return { ...result, status: stdout.trim() === "running" ? "running" : "stopped" };
    } catch {
      return { ...result, status: "stopped" };
    }
  }

  /**
   * Extract instance info from running container and save to
   * ~/.openclaw-installer/<name>/ on the host:
   *   - gateway-token (auth token)
   *   - .env (all env vars for the instance, secrets redacted with comment)
   */
  private async saveInstanceInfo(
    runtime: string,
    name: string,
    config: DeployConfig,
    log: LogCallback,
  ): Promise<void> {
    const instanceDir = join(homedir(), ".openclaw-installer", name);
    await mkdir(instanceDir, { recursive: true });

    // Wait for gateway to generate token on first start
    await new Promise((r) => setTimeout(r, 3000));

    // Save gateway token
    try {
      const { stdout } = await execFileAsync(runtime, [
        "exec",
        name,
        "node",
        "-e",
        "const c=JSON.parse(require('fs').readFileSync('/home/node/.openclaw/openclaw.json','utf8'));console.log(c.gateway?.auth?.token||'')",
      ]);
      const token = stdout.trim();
      if (token) {
        const tokenPath = join(instanceDir, "gateway-token");
        await writeFile(tokenPath, token + "\n", { mode: 0o600 });
        log(`Gateway token saved to ${tokenPath}`);
      }
    } catch {
      log("Could not extract gateway token (container may still be starting)");
    }

    // Save .env
    try {
      const lines = [
        `# OpenClaw instance: ${name}`,
        `# Generated by openclaw-installer`,
        `OPENCLAW_PREFIX=${config.prefix}`,
        `OPENCLAW_AGENT_NAME=${config.agentName}`,
        `OPENCLAW_DISPLAY_NAME=${config.agentDisplayName || config.agentName}`,
        `OPENCLAW_IMAGE=${DEFAULT_IMAGE}`,
        `OPENCLAW_PORT=${config.port ?? DEFAULT_PORT}`,
        `OPENCLAW_VOLUME=${volumeName(config)}`,
        `OPENCLAW_CONTAINER=${name}`,
        ``,
      ];

      if (config.anthropicApiKey) {
        lines.push(`# ANTHROPIC_API_KEY is set (value redacted)`);
        lines.push(`# ANTHROPIC_API_KEY=***`);
      }
      if (config.modelEndpoint) {
        lines.push(`MODEL_ENDPOINT=${config.modelEndpoint}`);
      }
      if (config.vertexEnabled) {
        lines.push(`VERTEX_ENABLED=true`);
        lines.push(`VERTEX_PROVIDER=${config.vertexProvider || "google"}`);
        if (config.googleCloudProject) {
          lines.push(`GOOGLE_CLOUD_PROJECT=${config.googleCloudProject}`);
        }
        if (config.googleCloudLocation) {
          lines.push(`GOOGLE_CLOUD_LOCATION=${config.googleCloudLocation}`);
        }
      }

      const envPath = join(instanceDir, ".env");
      await writeFile(envPath, lines.join("\n") + "\n", { mode: 0o600 });
      log(`Instance config saved to ${envPath}`);
    } catch {
      log("Could not save .env file");
    }
  }

  async stop(result: DeployResult, log: LogCallback): Promise<void> {
    const runtime = result.config.containerRuntime ?? "podman";
    const name = result.containerId ?? containerName(result.config);
    log(`Stopping container: ${name}`);
    // --rm will auto-remove the container
    await runCommand(runtime, ["stop", name], log);
    log("Container stopped and removed. Data volume preserved.");
  }

  async teardown(result: DeployResult, log: LogCallback): Promise<void> {
    const runtime = (result.config.containerRuntime ?? "podman") as ContainerRuntime;
    const name = result.containerId ?? containerName(result.config);

    // Stop container if running (--rm removes it)
    await removeContainer(runtime, name);

    const vol = volumeName(result.config);
    log(`Deleting data volume: ${vol}`);
    await removeVolume(runtime, vol);
    log("All data deleted.");
  }
}
