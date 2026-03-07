import { Router } from "express";
import {
  discoverContainers,
  discoverVolumes,
  detectRuntime,
  type DiscoveredContainer,
} from "../services/container.js";
import { LocalDeployer } from "../deployers/local.js";
import { createLogCallback, sendStatus } from "../ws.js";
import type { DeployResult } from "../deployers/types.js";

const router = Router();
const localDeployer = new LocalDeployer();

function containerToInstance(c: DiscoveredContainer): DeployResult {
  const prefix = c.labels["openclaw.prefix"] || "";
  const agent = c.labels["openclaw.agent"] || "";

  let port = 18789;
  const portMatch = String(c.ports).match(/(\d+)->18789/);
  if (portMatch) port = parseInt(portMatch[1], 10);

  return {
    id: c.name,
    mode: "local",
    status: c.status,
    config: {
      mode: "local",
      prefix: prefix || c.name.replace(/^openclaw-/, "").replace(/-[^-]+$/, ""),
      agentName: agent || c.name.split("-").pop() || c.name,
      agentDisplayName: agent
        ? agent.charAt(0).toUpperCase() + agent.slice(1)
        : c.name,
    },
    startedAt: c.createdAt,
    url: c.status === "running" ? `http://localhost:${port}` : undefined,
    containerId: c.name,
  };
}

// List all instances: running containers + stopped volumes (no container due to --rm)
router.get("/", async (_req, res) => {
  const runtime = await detectRuntime();
  if (!runtime) {
    res.json([]);
    return;
  }

  const containers = await discoverContainers(runtime);
  const volumes = await discoverVolumes(runtime);
  const instances: DeployResult[] = containers.map(containerToInstance);

  // Find volumes that don't have a running container — these are "stopped" instances
  const runningPrefixes = new Set(
    instances.map((i) => i.config.prefix),
  );

  for (const vol of volumes) {
    if (runningPrefixes.has(vol.prefix)) continue;

    instances.push({
      id: `openclaw-${vol.prefix}`,
      mode: "local",
      status: "stopped",
      config: {
        mode: "local",
        prefix: vol.prefix,
        agentName: vol.prefix,
        agentDisplayName: vol.prefix.charAt(0).toUpperCase() + vol.prefix.slice(1),
      },
      startedAt: "",
      containerId: `openclaw-${vol.prefix}`,
    });
  }

  res.json(instances);
});

// Get single instance by container name
router.get("/:id", async (req, res) => {
  const runtime = await detectRuntime();
  if (!runtime) {
    res.status(404).json({ error: "No container runtime" });
    return;
  }

  const containers = await discoverContainers(runtime);
  const c = containers.find((c) => c.name === req.params.id);
  if (!c) {
    // Check if there's a volume for it (stopped instance)
    const volumes = await discoverVolumes(runtime);
    const prefix = req.params.id.replace(/^openclaw-/, "");
    const vol = volumes.find((v) => v.prefix === prefix);
    if (vol) {
      res.json({
        id: req.params.id,
        mode: "local",
        status: "stopped",
        config: { mode: "local", prefix: vol.prefix, agentName: vol.prefix, agentDisplayName: vol.prefix },
        startedAt: "",
        containerId: req.params.id,
      });
      return;
    }
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  res.json(containerToInstance(c));
});

// Start instance (re-creates container with --rm, volume has the state)
router.post("/:id/start", async (req, res) => {
  const instance = await findInstance(req.params.id);
  if (!instance) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  const log = createLogCallback(instance.id);
  try {
    await localDeployer.start(instance, log);
    sendStatus(instance.id, "running");
    res.json({ status: "running" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${message}`);
    res.status(500).json({ error: message });
  }
});

// Stop instance (--rm auto-removes container, volume stays)
router.post("/:id/stop", async (req, res) => {
  const instance = await findInstance(req.params.id);
  if (!instance) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  const log = createLogCallback(instance.id);
  await localDeployer.stop(instance, log);
  sendStatus(instance.id, "stopped");
  res.json({ status: "stopped" });
});

// Get gateway token from running container
router.get("/:id/token", async (req, res) => {
  const runtime = await detectRuntime();
  if (!runtime) {
    res.status(500).json({ error: "No container runtime" });
    return;
  }

  const containers = await discoverContainers(runtime);
  const c = containers.find((c) => c.name === req.params.id);
  if (!c || c.status !== "running") {
    res.status(400).json({ error: "Instance must be running to read token" });
    return;
  }

  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync(runtime, [
      "exec",
      req.params.id,
      "node",
      "-e",
      "const c=JSON.parse(require('fs').readFileSync('/home/node/.openclaw/openclaw.json','utf8'));console.log(c.gateway?.auth?.token||'')",
    ]);
    const token = stdout.trim();
    if (token) {
      res.json({ token });
    } else {
      res.status(404).json({ error: "No token found in config" });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// Get the podman run command for a running container
router.get("/:id/command", async (req, res) => {
  const runtime = await detectRuntime();
  if (!runtime) {
    res.status(500).json({ error: "No container runtime" });
    return;
  }

  const containers = await discoverContainers(runtime);
  const c = containers.find((c) => c.name === req.params.id);
  if (!c || c.status !== "running") {
    res.status(400).json({ error: "Instance must be running" });
    return;
  }

  try {
    const { execFile: ef } = await import("node:child_process");
    const { promisify: p } = await import("node:util");
    const exec = p(ef);

    const { stdout } = await exec(runtime, ["inspect", "--format", "json", req.params.id]);
    const info = JSON.parse(stdout)[0] || JSON.parse(stdout);
    const config = info.Config || {};
    const hostConfig = info.HostConfig || {};

    // Build the command string
    const parts = [runtime, "run", "-d", "--rm"];

    // Name
    parts.push("--name", req.params.id);

    // Network
    if (hostConfig.NetworkMode === "host") {
      parts.push("--network", "host");
    } else {
      // Port mappings
      const portBindings = hostConfig.PortBindings || {};
      for (const [containerPort, bindings] of Object.entries(portBindings)) {
        if (Array.isArray(bindings)) {
          for (const b of bindings as Array<{ HostPort?: string }>) {
            const hostPort = b.HostPort || "";
            const cp = containerPort.replace("/tcp", "");
            parts.push("-p", `${hostPort}:${cp}`);
          }
        }
      }
    }

    // Environment (filter out sensitive keys)
    const envList: string[] = config.Env || [];
    for (const e of envList) {
      // Skip default system env vars
      if (e.startsWith("PATH=") || e.startsWith("HOSTNAME=") || e.startsWith("container=")) continue;
      // Mask API keys
      if (e.includes("API_KEY=") || e.includes("TOKEN=")) {
        const [key] = e.split("=");
        parts.push("-e", `${key}=***`);
      } else {
        parts.push("-e", `"${e}"`);
      }
    }

    // Volumes
    const mounts = info.Mounts || [];
    for (const m of mounts) {
      if (m.Type === "volume") {
        parts.push("-v", `${m.Name}:${m.Destination}`);
      } else if (m.Type === "bind") {
        parts.push("-v", `${m.Source}:${m.Destination}`);
      }
    }

    // Labels (openclaw ones only)
    const labels: Record<string, string> = config.Labels || {};
    for (const [k, v] of Object.entries(labels)) {
      if (k.startsWith("openclaw.")) {
        parts.push("--label", `${k}=${v}`);
      }
    }

    // Image
    parts.push(config.Image || c.image);

    // Command (if not default)
    const cmd: string[] = config.Cmd || [];
    if (cmd.length > 0) {
      parts.push(...cmd);
    }

    res.json({ command: parts.join(" \\\n  ") });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: message });
  }
});

// Delete data (remove volume — the nuclear option)
router.delete("/:id", async (req, res) => {
  const instance = await findInstance(req.params.id);
  if (!instance) {
    res.status(404).json({ error: "Instance not found" });
    return;
  }

  const log = createLogCallback(instance.id);
  await localDeployer.teardown(instance, log);
  res.json({ status: "deleted" });
});

// Helper: find instance by container name or volume
async function findInstance(name: string): Promise<DeployResult | null> {
  const runtime = await detectRuntime();
  if (!runtime) return null;

  // Check running containers first
  const containers = await discoverContainers(runtime);
  const c = containers.find((c) => c.name === name);
  if (c) return containerToInstance(c);

  // Check volumes (stopped instances)
  const volumes = await discoverVolumes(runtime);
  const prefix = name.replace(/^openclaw-/, "");
  const vol = volumes.find((v) => v.prefix === prefix);
  if (vol) {
    return {
      id: name,
      mode: "local",
      status: "stopped",
      config: {
        mode: "local",
        prefix: vol.prefix,
        agentName: vol.prefix,
        agentDisplayName: vol.prefix,
        containerRuntime: runtime,
      },
      startedAt: "",
      containerId: name,
    };
  }

  return null;
}

export default router;
