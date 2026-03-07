import React, { useEffect, useState } from "react";

type Mode = "local" | "kubernetes" | "ssh";

interface Props {
  onDeployStarted: (deployId: string) => void;
}

interface ServerDefaults {
  hasAnthropicKey: boolean;
  modelEndpoint: string;
  prefix: string;
}

const MODES = [
  {
    id: "local" as const,
    icon: "💻",
    title: "This Machine",
    desc: "Run OpenClaw locally with podman/docker",
  },
  {
    id: "kubernetes" as const,
    icon: "☸️",
    title: "Kubernetes / OpenShift",
    desc: "Deploy to a cluster",
  },
  {
    id: "ssh" as const,
    icon: "🖥️",
    title: "Remote Host",
    desc: "Deploy via SSH to a Linux machine",
  },
];

export default function DeployForm({ onDeployStarted }: Props) {
  const [mode, setMode] = useState<Mode>("local");
  const [deploying, setDeploying] = useState(false);
  const [defaults, setDefaults] = useState<ServerDefaults | null>(null);
  const [config, setConfig] = useState({
    prefix: "",
    agentName: "",
    agentDisplayName: "",
    anthropicApiKey: "",
    modelEndpoint: "",
    port: "18789",
    // Vertex AI
    vertexEnabled: false,
    vertexProvider: "google" as "google" | "anthropic",
    googleCloudProject: "",
    googleCloudLocation: "",
    // SSH fields
    sshHost: "",
    sshUser: "",
  });

  // Fetch server defaults (detected env vars)
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((data) => {
        if (data.defaults) {
          setDefaults(data.defaults);
          if (data.defaults.prefix) {
            setConfig((prev) => ({ ...prev, prefix: data.defaults.prefix }));
          }
          if (data.defaults.modelEndpoint) {
            setConfig((prev) => ({ ...prev, modelEndpoint: data.defaults.modelEndpoint }));
          }
        }
      })
      .catch(() => {});
  }, []);

  const update = (field: string, value: string) => {
    setConfig((prev) => ({ ...prev, [field]: value }));
    // Auto-derive display name from agent name
    if (field === "agentName" && !config.agentDisplayName) {
      setConfig((prev) => ({
        ...prev,
        agentName: value,
        agentDisplayName:
          value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " "),
      }));
    }
  };

  const handleDeploy = async () => {
    setDeploying(true);
    try {
      const body = {
        mode,
        prefix: config.prefix,
        agentName: config.agentName,
        agentDisplayName: config.agentDisplayName || config.agentName,
        anthropicApiKey: config.anthropicApiKey || undefined,
        modelEndpoint: config.modelEndpoint || undefined,
        port: parseInt(config.port, 10) || 18789,
        vertexEnabled: config.vertexEnabled || undefined,
        vertexProvider: config.vertexEnabled ? config.vertexProvider : undefined,
        googleCloudProject: config.vertexEnabled ? config.googleCloudProject : undefined,
        googleCloudLocation: config.vertexEnabled ? config.googleCloudLocation : undefined,
        sshHost: config.sshHost || undefined,
        sshUser: config.sshUser || undefined,
      };

      const res = await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await res.json();
      if (data.deployId) {
        onDeployStarted(data.deployId);
      }
    } catch (err) {
      console.error("Deploy failed:", err);
    } finally {
      setDeploying(false);
    }
  };

  const handleEnvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = reader.result as string;
      const vars: Record<string, string> = {};
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx < 0) continue;
        vars[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
      }
      setConfig((prev) => ({
        ...prev,
        prefix: vars.OPENCLAW_PREFIX || prev.prefix,
        agentName: vars.OPENCLAW_AGENT_NAME || prev.agentName,
        agentDisplayName: vars.OPENCLAW_DISPLAY_NAME || prev.agentDisplayName,
        port: vars.OPENCLAW_PORT || prev.port,
        modelEndpoint: vars.MODEL_ENDPOINT || prev.modelEndpoint,
        vertexEnabled: vars.VERTEX_ENABLED === "true" || prev.vertexEnabled,
        vertexProvider: (vars.VERTEX_PROVIDER as "google" | "anthropic") || prev.vertexProvider,
        googleCloudProject: vars.GOOGLE_CLOUD_PROJECT || prev.googleCloudProject,
        googleCloudLocation: vars.GOOGLE_CLOUD_LOCATION || prev.googleCloudLocation,
      }));
    };
    reader.readAsText(file);
    // Reset so the same file can be re-uploaded
    e.target.value = "";
  };

  const isValid = config.prefix && config.agentName;

  return (
    <div>
      {/* Mode selector */}
      <div className="mode-grid">
        {MODES.map((m) => (
          <div
            key={m.id}
            className={`mode-card ${mode === m.id ? "selected" : ""}`}
            onClick={() => setMode(m.id)}
          >
            <div className="mode-icon">{m.icon}</div>
            <div className="mode-title">{m.title}</div>
            <div className="mode-desc">{m.desc}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1rem" }}>
          <h3 style={{ margin: 0 }}>Configuration</h3>
          <label className="btn btn-ghost" style={{ cursor: "pointer", margin: 0 }}>
            Upload .env
            <input
              type="file"
              accept=".env,text/plain"
              onChange={handleEnvUpload}
              style={{ display: "none" }}
            />
          </label>
        </div>

        <div className="form-row">
          <div className="form-group">
            <label>Namespace Prefix</label>
            <input
              type="text"
              placeholder="e.g., sally"
              value={config.prefix}
              onChange={(e) => update("prefix", e.target.value)}
            />
            <div className="hint">
              {mode === "local"
                ? "Used for container naming"
                : "Creates <prefix>-openclaw namespace"}
            </div>
          </div>
          <div className="form-group">
            <label>Agent Name</label>
            <input
              type="text"
              placeholder="e.g., lynx"
              value={config.agentName}
              onChange={(e) => update("agentName", e.target.value)}
            />
            <div className="hint">Your agent's identity</div>
          </div>
        </div>

        <div className="form-group">
          <label>Display Name</label>
          <input
            type="text"
            placeholder="e.g., Lynx"
            value={config.agentDisplayName}
            onChange={(e) => update("agentDisplayName", e.target.value)}
          />
        </div>

        {mode === "local" && (
          <div className="form-group">
            <label>Port</label>
            <input
              type="text"
              placeholder="18789"
              value={config.port}
              onChange={(e) => update("port", e.target.value)}
            />
            <div className="hint">Local port for the gateway UI</div>
          </div>
        )}

        {mode === "ssh" && (
          <div className="form-row">
            <div className="form-group">
              <label>SSH Host</label>
              <input
                type="text"
                placeholder="nuc.local or 192.168.1.100"
                value={config.sshHost}
                onChange={(e) => update("sshHost", e.target.value)}
              />
            </div>
            <div className="form-group">
              <label>SSH User</label>
              <input
                type="text"
                placeholder="e.g., core"
                value={config.sshUser}
                onChange={(e) => update("sshUser", e.target.value)}
              />
            </div>
          </div>
        )}

        <h3 style={{ marginTop: "1.5rem" }}>Model Provider</h3>

        <div className="form-group">
          <label>Anthropic API Key</label>
          <input
            type="password"
            placeholder={defaults?.hasAnthropicKey ? "(using key from environment)" : "sk-ant-..."}
            value={config.anthropicApiKey}
            onChange={(e) => update("anthropicApiKey", e.target.value)}
          />
          <div className="hint">
            {defaults?.hasAnthropicKey
              ? "Detected ANTHROPIC_API_KEY from server environment — leave blank to use it"
              : "Optional — without it, agents use Vertex AI or the model endpoint"}
          </div>
        </div>

        <div className="form-group">
          <label>Model Endpoint</label>
          <input
            type="text"
            placeholder="http://vllm.openclaw-llms.svc.cluster.local/v1"
            value={config.modelEndpoint}
            onChange={(e) => update("modelEndpoint", e.target.value)}
          />
          <div className="hint">
            OpenAI-compatible endpoint (leave blank for Anthropic API or Vertex)
          </div>
        </div>

        <div className="form-group">
          <label style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <input
              type="checkbox"
              checked={config.vertexEnabled}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, vertexEnabled: e.target.checked }))
              }
              style={{ width: "auto" }}
            />
            Enable Google Vertex AI
          </label>
          <div className="hint">
            Use Claude or Gemini via Google Cloud Vertex AI
          </div>
        </div>

        {config.vertexEnabled && (
          <>
            <div className="form-group">
              <label>Vertex Provider</label>
              <select
                value={config.vertexProvider}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    vertexProvider: e.target.value as "google" | "anthropic",
                  }))
                }
              >
                <option value="google">Google (Gemini)</option>
                <option value="anthropic">Anthropic (Claude via Vertex)</option>
              </select>
              <div className="hint">
                {config.vertexProvider === "google"
                  ? "Agents use google-vertex/gemini-2.5-pro"
                  : "Agents use anthropic-vertex/claude-sonnet-4-6"}
              </div>
            </div>

            <div className="form-row">
              <div className="form-group">
                <label>GCP Project ID</label>
                <input
                  type="text"
                  placeholder="my-gcp-project"
                  value={config.googleCloudProject}
                  onChange={(e) => update("googleCloudProject", e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>GCP Region</label>
                <input
                  type="text"
                  placeholder={config.vertexProvider === "anthropic" ? "us-east5" : "us-central1"}
                  value={config.googleCloudLocation}
                  onChange={(e) => update("googleCloudLocation", e.target.value)}
                />
              </div>
            </div>
          </>
        )}

        <div style={{ marginTop: "1.5rem" }}>
          <button
            className="btn btn-primary"
            disabled={!isValid || deploying}
            onClick={handleDeploy}
          >
            {deploying ? "Deploying..." : "Deploy OpenClaw"}
          </button>
        </div>
      </div>
    </div>
  );
}
