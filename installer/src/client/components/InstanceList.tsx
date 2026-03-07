import React, { useEffect, useState } from "react";

interface Instance {
  id: string;
  mode: string;
  status: string;
  config: {
    prefix: string;
    agentName: string;
    agentDisplayName: string;
  };
  startedAt: string;
  url?: string;
  containerId?: string;
  error?: string;
}

type ExpandedPanel = "token" | "command" | null;

export default function InstanceList() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, ExpandedPanel>>({});
  const [panelData, setPanelData] = useState<Record<string, string>>({});

  const fetchInstances = async () => {
    try {
      const res = await fetch("/api/instances");
      const data = await res.json();
      setInstances(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchInstances();
    const interval = setInterval(fetchInstances, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleStart = async (id: string) => {
    setActing(id);
    await fetch(`/api/instances/${id}/start`, { method: "POST" });
    await fetchInstances();
    setActing(null);
  };

  const handleStop = async (id: string) => {
    setActing(id);
    await fetch(`/api/instances/${id}/stop`, { method: "POST" });
    setExpanded((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    await fetchInstances();
    setActing(null);
  };

  const handleDeleteData = async (id: string) => {
    if (
      !confirm(
        "Delete all data? This removes the data volume (config, sessions, workspaces). Cannot be undone.",
      )
    )
      return;
    setActing(id);
    await fetch(`/api/instances/${id}`, { method: "DELETE" });
    await fetchInstances();
    setActing(null);
  };

  const togglePanel = async (id: string, panel: ExpandedPanel) => {
    if (expanded[id] === panel) {
      setExpanded((prev) => ({ ...prev, [id]: null }));
      return;
    }

    const endpoint = panel === "token" ? "token" : "command";
    try {
      const res = await fetch(`/api/instances/${id}/${endpoint}`);
      const data = await res.json();
      const value = panel === "token" ? data.token : data.command;
      if (value) {
        setPanelData((prev) => ({ ...prev, [`${id}-${panel}`]: value }));
        setExpanded((prev) => ({ ...prev, [id]: panel }));
      }
    } catch {
      // ignore
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
  };

  if (loading) {
    return <div className="card">Loading...</div>;
  }

  if (instances.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">📦</div>
        <p>No OpenClaw instances found</p>
        <p style={{ fontSize: "0.85rem" }}>
          Deploy from the Deploy tab, or start a container manually — any
          container running an OpenClaw image will appear here automatically.
        </p>
      </div>
    );
  }

  return (
    <div className="card" style={{ padding: 0 }}>
      {instances.map((inst) => {
        const isActing = acting === inst.id;
        const activePanel = expanded[inst.id];
        const panelContent = panelData[`${inst.id}-${activePanel}`];
        return (
          <div key={inst.id} style={{ borderBottom: "1px solid var(--border)" }}>
            <div className="instance-row">
              <div className="instance-info">
                <div className="instance-name">
                  {inst.containerId || inst.id}
                  <span
                    className={`badge badge-${inst.status}`}
                    style={{ marginLeft: "0.5rem" }}
                  >
                    {isActing ? "..." : inst.status}
                  </span>
                </div>
                <div className="instance-meta">
                  {inst.config.prefix && `${inst.config.prefix} · `}
                  {inst.config.agentName && `${inst.config.agentName} · `}
                  {inst.status === "running" && inst.url ? (
                    <a
                      href={inst.url}
                      target="_blank"
                      rel="noopener"
                      style={{ color: "var(--accent)" }}
                    >
                      {inst.url}
                    </a>
                  ) : (
                    "stopped — data volume preserved"
                  )}
                </div>
              </div>
              <div className="instance-actions">
                {inst.status === "running" && (
                  <>
                    <button
                      className="btn btn-ghost"
                      onClick={() => togglePanel(inst.id, "token")}
                    >
                      {activePanel === "token" ? "Hide" : "Token"}
                    </button>
                    <button
                      className="btn btn-ghost"
                      onClick={() => togglePanel(inst.id, "command")}
                    >
                      {activePanel === "command" ? "Hide" : "Command"}
                    </button>
                  </>
                )}
                {inst.status === "stopped" && (
                  <button
                    className="btn btn-primary"
                    disabled={isActing}
                    onClick={() => handleStart(inst.id)}
                  >
                    Start
                  </button>
                )}
                {inst.status === "running" && (
                  <button
                    className="btn btn-ghost"
                    disabled={isActing}
                    onClick={() => handleStop(inst.id)}
                  >
                    Stop
                  </button>
                )}
                <button
                  className="btn btn-danger"
                  disabled={isActing || inst.status === "running"}
                  onClick={() => handleDeleteData(inst.id)}
                  title={
                    inst.status === "running"
                      ? "Stop the instance first"
                      : "Delete data volume (config, sessions, workspaces)"
                  }
                >
                  Delete Data
                </button>
              </div>
            </div>
            {activePanel && panelContent && (
              <div
                style={{
                  padding: "0 1rem 1rem",
                  display: "flex",
                  alignItems: "flex-start",
                  gap: "0.5rem",
                }}
              >
                <code
                  style={{
                    flex: 1,
                    padding: "0.5rem 0.75rem",
                    background: "var(--bg-primary)",
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-sm)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "0.8rem",
                    color: "var(--text-secondary)",
                    wordBreak: "break-all",
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {panelContent}
                </code>
                <button
                  className="btn btn-ghost"
                  onClick={() => handleCopy(panelContent)}
                >
                  Copy
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
