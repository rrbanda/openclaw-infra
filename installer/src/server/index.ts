import express from "express";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { setupWebSocket } from "./ws.js";
import deployRoutes from "./routes/deploy.js";
import statusRoutes from "./routes/status.js";
import agentsRoutes from "./routes/agents.js";
import { detectRuntime } from "./services/container.js";

const app = express();
const server = createServer(app);
const PORT = parseInt(process.env.PORT ?? "3000", 10);

app.use(express.json());

// API routes
app.use("/api/deploy", deployRoutes);
app.use("/api/instances", statusRoutes);
app.use("/api/agents", agentsRoutes);

// Health check + environment defaults for the frontend
app.get("/api/health", async (_req, res) => {
  const runtime = await detectRuntime();
  res.json({
    status: "ok",
    containerRuntime: runtime,
    version: "0.1.0",
    defaults: {
      hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
      modelEndpoint: process.env.MODEL_ENDPOINT || "",
      prefix: process.env.OPENCLAW_PREFIX || "",
    },
  });
});

// Serve frontend — check both dev (vite build output) and production (Dockerfile) paths
const clientCandidates = [
  resolve(import.meta.dirname, "..", "..", "dist", "client"), // from src/server/ after vite build
  join(import.meta.dirname, "..", "client"),                   // from dist/server/ in container
];
const clientDir = clientCandidates.find((dir) =>
  existsSync(join(dir, "index.html")),
);
if (clientDir) {
  app.use(
    express.static(clientDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith(".js")) res.setHeader("Content-Type", "application/javascript");
        else if (filePath.endsWith(".css")) res.setHeader("Content-Type", "text/css");
      },
    }),
  );
  app.get("*", (_req, res) => {
    res.sendFile(join(clientDir, "index.html"));
  });
}

// WebSocket
setupWebSocket(server);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenClaw Installer running at http://0.0.0.0:${PORT}`);
});
