export type DeployMode = "local" | "kubernetes" | "ssh" | "fleet";

export interface DeployConfig {
  mode: DeployMode;
  // Common
  agentName: string;
  agentDisplayName: string;
  prefix: string;
  // Model provider (all optional — without them, agents use in-cluster model)
  anthropicApiKey?: string;
  modelEndpoint?: string;
  // Vertex AI
  vertexEnabled?: boolean;
  vertexProvider?: "google" | "anthropic"; // google = Gemini, anthropic = Claude via Vertex
  googleCloudProject?: string;
  googleCloudLocation?: string;
  // Local mode
  containerRuntime?: "podman" | "docker";
  port?: number;
  // Kubernetes mode
  namespace?: string;
  withA2a?: boolean;
  // SSH mode
  sshHost?: string;
  sshUser?: string;
  sshKeyPath?: string;
}

export interface DeployResult {
  id: string;
  mode: DeployMode;
  status: "running" | "stopped" | "failed" | "unknown";
  config: DeployConfig;
  startedAt: string;
  url?: string;
  containerId?: string;
  error?: string;
}

export type LogCallback = (line: string) => void;

export interface Deployer {
  deploy(config: DeployConfig, log: LogCallback): Promise<DeployResult>;
  start(result: DeployResult, log: LogCallback): Promise<DeployResult>;
  status(result: DeployResult): Promise<DeployResult>;
  stop(result: DeployResult, log: LogCallback): Promise<void>;
  teardown(result: DeployResult, log: LogCallback): Promise<void>;
}
