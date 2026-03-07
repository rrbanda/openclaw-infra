import { Router } from "express";
import { v4 as uuid } from "uuid";
import type { DeployConfig } from "../deployers/types.js";
import { LocalDeployer } from "../deployers/local.js";
import { createLogCallback, sendStatus } from "../ws.js";

const router = Router();
const localDeployer = new LocalDeployer();

function getDeployer(mode: string) {
  switch (mode) {
    case "local":
      return localDeployer;
    // TODO: kubernetes, ssh, fleet deployers
    default:
      return null;
  }
}

router.post("/", async (req, res) => {
  const config = req.body as DeployConfig;

  if (!config.mode || !config.agentName || !config.prefix) {
    res.status(400).json({
      error: "Missing required fields: mode, agentName, prefix",
    });
    return;
  }

  // Fall back to server environment for API keys and provider config
  if (!config.anthropicApiKey && process.env.ANTHROPIC_API_KEY) {
    config.anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  }
  if (!config.modelEndpoint && process.env.MODEL_ENDPOINT) {
    config.modelEndpoint = process.env.MODEL_ENDPOINT;
  }
  if (config.vertexEnabled === undefined && process.env.VERTEX_ENABLED === "true") {
    config.vertexEnabled = true;
    config.vertexProvider = (process.env.VERTEX_PROVIDER as "google" | "anthropic") || "google";
    config.googleCloudProject = config.googleCloudProject || process.env.GOOGLE_CLOUD_PROJECT || "";
    config.googleCloudLocation = config.googleCloudLocation || process.env.GOOGLE_CLOUD_LOCATION || "";
  }

  const deployer = getDeployer(config.mode);
  if (!deployer) {
    res.status(400).json({ error: `Unsupported mode: ${config.mode}` });
    return;
  }

  const deployId = uuid();
  const log = createLogCallback(deployId);

  // Return immediately with the deploy ID — logs stream via WebSocket
  res.status(202).json({ deployId });

  // Run deployment in background
  // Container is discoverable via podman labels + image name — no state file needed
  try {
    log("Starting deployment...");
    await deployer.deploy(config, log);
    sendStatus(deployId, "running");
    log("Deployment complete!");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`ERROR: ${message}`);
    sendStatus(deployId, "failed");
  }
});

export default router;
