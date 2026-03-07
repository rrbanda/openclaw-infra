import React, { useEffect, useState } from "react";

interface AgentInfo {
  id: string;
  path: string;
  hasAgentsMd: boolean;
  hasJobMd: boolean;
  description?: string;
}

export default function AgentBrowser() {
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [repoUrl, setRepoUrl] = useState("");

  // Load local agents on mount
  useEffect(() => {
    fetch("/api/agents/local")
      .then((r) => r.json())
      .then(setAgents)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const browseRepo = async () => {
    if (!repoUrl) return;
    setLoading(true);
    try {
      const res = await fetch(
        `/api/agents/browse?repo=${encodeURIComponent(repoUrl)}`,
      );
      const data = await res.json();
      setAgents(data);
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="card">
        <h3>Import from Git Repository</h3>
        <div className="form-group" style={{ display: "flex", gap: "0.5rem" }}>
          <input
            type="text"
            placeholder="https://github.com/org/agents-repo.git"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn btn-primary" onClick={browseRepo}>
            Browse
          </button>
        </div>
      </div>

      <div className="card">
        <h3>Available Agents</h3>
        {loading && <p>Loading...</p>}
        {!loading && agents.length === 0 && (
          <div className="empty-state">
            <p>No agents found</p>
          </div>
        )}
        {agents.map((agent) => (
          <div key={agent.id} className="instance-row">
            <div className="instance-info">
              <div className="instance-name">{agent.id}</div>
              <div className="instance-meta">
                {agent.description || "No description"}
                {agent.hasJobMd && " · Has scheduled job"}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
