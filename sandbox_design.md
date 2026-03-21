# Per-Agent Sandbox Isolation for OpenClaw on OpenShift

> Design document for running OpenClaw agents in isolated Agent Sandbox pods with defense-in-depth security, informed by NVIDIA NemoClaw's security model and the Kubernetes Agent Sandbox operator.

**Status:** Proposal  
**Author:** RB
**Date:** 2026-03-21  
**Related:**
- [Agent Sandbox (kubernetes-sigs)](https://agent-sandbox.sigs.k8s.io/)
- [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw) / [Docs](https://docs.nvidia.com/nemoclaw/latest/)
- [Google Cloud: Isolate AI code execution with Agent Sandbox](https://cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox)

---

## 1. Problem Statement

OpenClaw agents are **in-process identities** inside a single Node.js gateway. All agents share one process, one PVC, one set of secrets, and one network namespace. A compromised or misbehaving agent can:

- Read other agents' workspace data and session transcripts
- Access API keys and tokens belonging to other agents (e.g., `OC_TOKEN` for resource_optimizer)
- Make arbitrary network calls to any endpoint
- Modify the gateway config or other agents' files

This is the same problem [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw) addresses for workstations (wrapping the entire gateway in an OpenShell sandbox), but we need a **Kubernetes-native solution** that provides **per-agent isolation** -- not just per-gateway.

## 2. Current Architecture

```
┌─────────────────── Sandbox CR: openclaw ───────────────────┐
│                                                             │
│  ┌──────────┐  ┌──────────────────────┐  ┌──────────────┐  │
│  │ oauth-   │  │  Gateway (Node.js)   │  │  agent-card  │  │
│  │ proxy    │  │                      │  │  (A2A bridge) │  │
│  │ :8443    │  │  shadowman agent  ───┼──┤              │  │
│  │          │  │  resource_optimizer──┼──┤  :8080       │  │
│  │          │  │  mlops_monitor    ───┼──┤              │  │
│  │          │  │                      │  │              │  │
│  │          │  │  :18789              │  │              │  │
│  └──────────┘  └──────────┬───────────┘  └──────────────┘  │
│                           │                                 │
│                  ┌────────┴────────┐                        │
│                  │ openclaw-home-  │                        │
│                  │ pvc (shared)    │                        │
│                  └─────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

**All agents share:** process, memory, filesystem (PVC), secrets, network namespace, and API keys.

## 3. Industry Context

### 3.1 NVIDIA NemoClaw (Workstation Pattern)

NemoClaw runs the entire OpenClaw gateway inside an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox with four isolation layers:

| Layer | Mechanism | What It Controls |
|-------|-----------|-----------------|
| **Network** | Default-deny egress with per-binary allowlists | Which hosts each binary can reach |
| **Filesystem** | Landlock LSM + container FS | `/sandbox` + `/tmp` writable; everything else read-only |
| **Process** | seccomp + netns + dedicated user | No privilege escalation, restricted syscalls |
| **Inference** | Gateway-intercepted routing | All LLM calls proxied through controlled backend |

**Key policy design from NemoClaw** (source: `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`):

- Per-binary network rules: `openclaw` binary can reach `clawhub.com` and `openclaw.ai`; `claude` binary can reach `api.anthropic.com`; `gh`/`git` can reach `github.com`
- Operator approval flow for unlisted destinations (real-time TUI prompt)
- Inference never leaves sandbox directly -- routed through OpenShell gateway

**Limitation:** NemoClaw provides per-gateway isolation, not per-agent. All agents in the same gateway share the sandbox. It targets workstations, not Kubernetes.

### 3.2 Kubernetes Agent Sandbox (Cluster Pattern)

The [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) operator provides:

- `Sandbox` CR: singleton stateful pod with stable identity and persistent storage
- `SandboxTemplate`: reusable pod blueprints with built-in `NetworkPolicy` support
- `SandboxClaim`: user/automation requests a sandbox from a template
- `SandboxWarmPool`: pre-warmed pods for instant allocation
- Runtime class support: gVisor (GKE default) or Kata Containers (OpenShift)

**Key capability:** The `SandboxTemplate.spec.networkPolicy` field accepts standard Kubernetes `NetworkPolicyIngressRule` and `NetworkPolicyEgressRule` objects. The controller auto-creates a shared NetworkPolicy per template with default-deny posture.

**Cluster state:** Agent Sandbox controller v0.2.1 is running on the target OpenShift cluster with all 4 CRDs registered and extensions enabled. Kata RuntimeClass is available on all nodes.

## 4. Proposed Architecture

Combine NemoClaw's security philosophy (defense-in-depth, default-deny, inference routing) with Agent Sandbox's Kubernetes-native isolation (per-pod sandboxes, NetworkPolicy, warm pools).

```
┌────────────────── Sandbox CR: openclaw-gateway ──────────────────┐
│                                                                   │
│  ┌──────────┐  ┌────────────────────────┐  ┌──────────────────┐  │
│  │ oauth-   │  │  Gateway (Node.js)     │  │  inference-proxy │  │
│  │ proxy    │  │                        │  │  (routes LLM     │  │
│  │ :8443    │  │  shadowman agent       │  │   calls to       │  │
│  │          │  │  (interactive, trusted) │  │   providers)     │  │
│  │          │  │                        │  │  :18792          │  │
│  └──────────┘  └───────────┬────────────┘  └──────────────────┘  │
│                            │                                      │
│                   SandboxClaim API                                │
│                            │                                      │
└────────────────────────────┼──────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
┌─────────────────┐ ┌───────────────┐ ┌──────────────────┐
│ SandboxClaim:   │ │ SandboxClaim: │ │ SandboxClaim:    │
│ resource_       │ │ mlops_        │ │ user_added_      │
│ optimizer       │ │ monitor       │ │ agent            │
│                 │ │               │ │                  │
│ ┌─────────────┐ │ │ ┌───────────┐ │ │ ┌──────────────┐ │
│ │ Agent       │ │ │ │ Agent     │ │ │ │ Agent        │ │
│ │ Runtime     │ │ │ │ Runtime   │ │ │ │ Runtime      │ │
│ │ (own PVC,   │ │ │ │ (own PVC, │ │ │ │ (own PVC,    │ │
│ │  own secrets)│ │ │ │  own keys)│ │ │ │  own secrets) │ │
│ └─────────────┘ │ │ └───────────┘ │ │ └──────────────┘ │
│                 │ │               │ │                  │
│ NetworkPolicy:  │ │ NetworkPolicy │ │ NetworkPolicy    │
│ gateway + model │ │ gateway +     │ │ gateway + model  │
│ API only        │ │ MLflow only   │ │ API only         │
└─────────────────┘ └───────────────┘ └──────────────────┘
        │                   │                   │
   ┌────┴────┐         ┌───┴───┐          ┌────┴────┐
   │ own PVC │         │ own   │          │ own PVC │
   │ (10Gi)  │         │ PVC   │          │ (10Gi)  │
   └─────────┘         └───────┘          └─────────┘
```

### 4.1 Trust Model

| Agent Type | Where It Runs | Why |
|-----------|---------------|-----|
| **Interactive** (shadowman) | Supervisor gateway | Low latency needed; user-controlled; lowest risk |
| **Scheduled/automated** (resource_optimizer, mlops_monitor) | Own Sandbox, own PVC | Runs unattended with elevated permissions (K8s tokens); highest risk |
| **User-added agents** (via add-agent.sh) | Own Sandbox, own PVC | Unknown trust level; should be isolated by default |

### 4.2 Security Layers (NemoClaw-Inspired)

| Layer | Implementation on OpenShift |
|-------|---------------------------|
| **Network** | `SandboxTemplate.spec.networkPolicy` with default-deny egress; allow only gateway inference proxy + specific external APIs |
| **Filesystem** | Per-agent PVC via `volumeClaimTemplates`; `readOnlyRootFilesystem: true`; no access to other agents' data |
| **Process** | Kata RuntimeClass (VM-level isolation); `runAsNonRoot: true`; `allowPrivilegeEscalation: false` |
| **Inference** | All LLM API calls routed through gateway's inference proxy; agent sandboxes cannot reach model APIs directly |
| **Secrets** | Per-agent secrets; no shared `openclaw-secrets`; each agent only gets the keys it needs |

### 4.3 Communication Flow

```
User ──► OAuth Proxy ──► Gateway ──► Agent Sandbox (via headless Service DNS)
                            │
                            ├── resource_optimizer.raghu-openclaw.svc.cluster.local
                            ├── mlops_monitor.raghu-openclaw.svc.cluster.local
                            └── <agent_name>.raghu-openclaw.svc.cluster.local
```

The gateway communicates with agent sandboxes via the headless Service that the Sandbox controller creates for each Sandbox CR. Each sandbox's FQDN is `<sandbox-name>.<namespace>.svc.cluster.local`.

## 5. Implementation Phases

### Phase 1: Agent SandboxTemplate + NetworkPolicy

Create the foundational `SandboxTemplate` that defines how agent sandboxes are provisioned.

**New files:**

`platform/agent-sandbox/agent-sandbox-template.yaml.envsubst`:

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: openclaw-agent-template
  namespace: ${OPENCLAW_NAMESPACE}
spec:
  podTemplate:
    metadata:
      labels:
        app: openclaw-agent
        openclaw.dev/role: agent
    spec:
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        runAsGroup: 1000
        fsGroup: 1000
      containers:
      - name: agent-runtime
        image: ${OPENCLAW_IMAGE}
        command: ["node", "/app/dist/index.js", "gateway", "run",
                  "--bind", "loopback", "--port", "18789", "--verbose"]
        env:
        - name: HOME
          value: /home/node
        - name: OPENCLAW_CONFIG_DIR
          value: /home/node/.openclaw
        - name: NODE_OPTIONS
          value: "--max-old-space-size=1536"
        - name: NODE_ENV
          value: production
        ports:
        - containerPort: 18789
          name: gateway
        resources:
          requests:
            memory: 512Mi
            cpu: 250m
          limits:
            memory: 2Gi
            cpu: 1000m
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop: ["ALL"]
        volumeMounts:
        - name: tmp-volume
          mountPath: /tmp
      volumes:
      - name: tmp-volume
        emptyDir: {}

  # NemoClaw-inspired network policy: default-deny with explicit allowlist
  networkPolicy:
    ingress:
      # Only allow traffic from the supervisor gateway
      - from:
        - podSelector:
            matchLabels:
              app: openclaw
    egress:
      # DNS resolution
      - ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
      # Gateway inference proxy (LLM calls routed through supervisor)
      - to:
        - podSelector:
            matchLabels:
              app: openclaw
        ports:
        - protocol: TCP
          port: 18789
```

`platform/agent-sandbox/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- agent-sandbox-template.yaml
```

**New RBAC** (`platform/agent-sandbox/sandbox-rbac.yaml.envsubst`):

```yaml
# Allow the gateway ServiceAccount to create/manage SandboxClaims
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: openclaw-sandbox-manager
  namespace: ${OPENCLAW_NAMESPACE}
rules:
- apiGroups: ["extensions.agents.x-k8s.io"]
  resources: [sandboxclaims]
  verbs: [get, list, watch, create, update, delete]
- apiGroups: ["agents.x-k8s.io"]
  resources: [sandboxes]
  verbs: [get, list, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: openclaw-sandbox-manager
  namespace: ${OPENCLAW_NAMESPACE}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: openclaw-sandbox-manager
subjects:
- kind: ServiceAccount
  name: openclaw-oauth-proxy
  namespace: ${OPENCLAW_NAMESPACE}
```

**Validation:**
- Apply the SandboxTemplate to the cluster
- Create a test SandboxClaim manually
- Verify pod creation, headless Service DNS, and NetworkPolicy enforcement
- Verify Kata runtime works with this simple pod spec (1 container, 1 volume -- unlike the 11-volume gateway that timed out)

---

### Phase 2: Per-Agent Sandbox Provisioning

Modify the agent lifecycle scripts to create SandboxClaims instead of workspace directories.

**Modified files:**

`scripts/add-agent.sh` -- When adding a new agent:

1. Generate a per-agent `openclaw.json` ConfigMap containing only that agent's config
2. Generate a per-agent Secret with only the API keys that agent needs
3. Create a `SandboxClaim` referencing `openclaw-agent-template`
4. Wait for the Sandbox to be Ready
5. Seed workspace files into the agent's PVC via `kubectl exec`

`scripts/setup-agents.sh` -- For pre-built agents (resource_optimizer, mlops_monitor):

1. Create per-agent ConfigMaps as before
2. Create SandboxClaims instead of writing workspace directories into the shared PVC
3. Wait for all agent sandboxes to be Ready
4. Seed workspace files into each agent's pod

**New file:** `agents/openclaw/skills/sandbox-agents/SKILL.md`

Teach the supervisor gateway how to communicate with agent sandboxes:

```markdown
# Sandbox Agent Communication

When you need to communicate with an isolated agent, use the agent's
headless Service DNS name to send HTTP requests:

  http://<agent-sandbox-name>.<namespace>.svc.cluster.local:18789

The gateway token for each agent sandbox is stored in the agent's
Secret resource. Use `kubectl get secret` to retrieve it if needed.
```

---

### Phase 3: Inference Proxy

Implement NemoClaw's inference routing pattern: agent sandboxes should not reach model APIs directly. All inference calls go through the supervisor gateway.

**New container** in the supervisor gateway pod: `inference-proxy`

- Lightweight HTTP proxy (Python or envoy) that forwards `/v1/chat/completions` requests to configured model providers
- Agent sandboxes have their `ANTHROPIC_API_KEY` / `GOOGLE_AI_API_KEY` env vars replaced with a reference to the proxy endpoint
- NetworkPolicy on agent sandboxes only allows egress to the supervisor gateway -- model API endpoints (api.anthropic.com, generativelanguage.googleapis.com) are blocked

This mirrors NemoClaw's architecture:
```
Agent (sandbox) ──► Supervisor gateway (inference-proxy) ──► Model provider
                                                              ├── Anthropic
                                                              ├── Google AI
                                                              └── In-cluster vLLM
```

**Why:** If an agent sandbox is compromised, the attacker cannot exfiltrate data through model API calls because they never have direct access to model endpoints or API keys.

---

### Phase 4: WarmPool + Lifecycle 

**New file:** `platform/agent-sandbox/agent-warmpool.yaml.envsubst`:

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: openclaw-agent-warmpool
  namespace: ${OPENCLAW_NAMESPACE}
spec:
  replicas: 2
  sandboxTemplateRef:
    name: openclaw-agent-template
```

This pre-warms 2 agent pods so new agents can be provisioned instantly (warm pool adoption) instead of waiting for image pull + container start.

**Lifecycle controls:**

- Scheduled agents (resource_optimizer, mlops_monitor) get `lifecycle.shutdownTime` on their SandboxClaims for automatic cleanup
- Idle agent detection: agents with no activity for N hours can be scaled to zero (`spec.replicas: 0`) and resumed on demand

---

## 6. File Change Summary

| Phase | Action | File | Description |
|-------|--------|------|-------------|
| 1 | CREATE | `platform/agent-sandbox/agent-sandbox-template.yaml.envsubst` | SandboxTemplate with NetworkPolicy |
| 1 | CREATE | `platform/agent-sandbox/sandbox-rbac.yaml.envsubst` | RBAC for SandboxClaim management |
| 1 | CREATE | `platform/agent-sandbox/kustomization.yaml` | Kustomize config |
| 2 | MODIFY | `scripts/add-agent.sh` | Create SandboxClaim instead of shared workspace |
| 2 | MODIFY | `scripts/setup-agents.sh` | Create per-agent SandboxClaims |
| 2 | CREATE | `agents/openclaw/skills/sandbox-agents/SKILL.md` | Agent communication skill |
| 3 | CREATE | `agents/openclaw/base/inference-proxy.yaml` | Inference proxy container config |
| 3 | MODIFY | `agents/openclaw/base/openclaw-sandbox.yaml.envsubst` | Add inference-proxy container |
| 4 | CREATE | `platform/agent-sandbox/agent-warmpool.yaml.envsubst` | WarmPool for fast provisioning |
| ALL | MODIFY | `CLAUDE.md` | Document the full architecture |

## 7. Security Comparison

| Threat | Current (shared gateway) | Option A (gateway in Sandbox) | This Design (per-agent Sandbox) |
|--------|-------------------------|------------------------------|-------------------------------|
| Agent reads another agent's data | Possible (shared PVC) | Possible (shared PVC) | **Blocked** (separate PVCs) |
| Agent steals API keys | Possible (shared secrets) | Possible (shared secrets) | **Blocked** (per-agent secrets) |
| Agent makes arbitrary network calls | Possible (no NetworkPolicy) | Possible (no NetworkPolicy) | **Blocked** (default-deny egress) |
| Agent accesses model API directly | Possible (keys in env) | Possible (keys in env) | **Blocked** (inference proxy) |
| Agent escapes container | Possible (runc) | Possible (runc) | **Blocked** (Kata VM) |
| Agent modifies gateway config | Possible (shared filesystem) | Possible (shared filesystem) | **Blocked** (separate pod) |
| Compromised agent lateral movement | Full access to pod | Full access to pod | **Contained** to own Sandbox |

## 8. Kata Runtime Compatibility

The gateway pod (Option A) is too complex for Kata (3 containers + 11 volume mounts -- the Kata sandbox creation times out). Per-agent sandboxes solve this:

| | Gateway Pod (Option A) | Agent Sandbox (This Design) |
|-|----------------------|---------------------------|
| Containers | 3 (oauth-proxy, gateway, agent-card) | 1 (agent-runtime) |
| Init containers | 1 (init-config) | 1 (init-config, simpler) |
| Volume mounts | 11 | 2-3 (PVC + config + tmp) |
| Kata compatible | No (timeout) | **Yes** (simple spec) |
| Kata overhead | N/A | 250m CPU + 350Mi memory per agent |

## 9. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| OpenClaw gateway does not support single-agent mode cleanly | Low | High | Gateway already supports `agents.list` with one entry; validated in current setup |
| Agent-to-gateway HTTP communication adds latency | Medium | Low | Headless Service DNS is in-cluster; sub-millisecond. WarmPool eliminates cold start |
| Per-agent PVCs consume more storage | Medium | Low | Use smaller PVCs (5Gi per agent vs 20Gi shared); lifecycle cleanup |
| Inference proxy adds latency to LLM calls | Low | Low | Simple HTTP proxy; < 1ms overhead |
| Kata overhead per agent is significant | Medium | Medium | Only enable Kata for highest-risk agents; use runc for trusted agents |
| SandboxTemplate NetworkPolicy too restrictive | Medium | Medium | Start with egress to gateway only; add rules incrementally based on agent needs |
| Agent Sandbox controller v0.2.1 is alpha | Medium | High | Option A already validates basic functionality; monitor upstream releases |

## 10. Testing Plan

| Test | Phase | Method |
|------|-------|--------|
| SandboxTemplate creates pods with correct NetworkPolicy | 1 | Apply template + claim; verify NetworkPolicy resource; test egress with `curl` from pod |
| Kata runtime works with simple agent pod | 1 | Create claim with `runtimeClassName: kata`; verify all containers start |
| Agent sandbox reachable from gateway via DNS | 2 | `curl http://<sandbox>.raghu-openclaw.svc.cluster.local:18789` from gateway |
| Agent sandbox cannot reach model APIs directly | 2 | `curl https://api.anthropic.com` from agent pod (should be blocked) |
| Inference proxy routes LLM calls correctly | 3 | Send chat completion request through proxy; verify response |
| WarmPool provides fast allocation | 4 | Create claim; measure time to Ready vs cold start |
| Scale-to-zero preserves agent PVC data | 4 | Scale to 0; scale to 1; verify workspace files intact |

## 11. Relationship to NemoClaw

This design adapts NemoClaw's security philosophy for Kubernetes:

| NemoClaw Concept | This Design's Equivalent |
|-----------------|------------------------|
| OpenShell sandbox | Agent Sandbox CR (Kubernetes-native) |
| `openclaw-sandbox.yaml` policy | `SandboxTemplate.spec.networkPolicy` |
| Per-binary network rules | Not available in K8s NetworkPolicy (future: consider Cilium L7 policy) |
| Operator TUI approval flow | Not implemented (static policy); future: admission webhook |
| Landlock + seccomp | Kata VM isolation (stronger boundary) |
| Inference routing through OpenShell | Inference proxy container in supervisor gateway |
| `/sandbox` + `/tmp` writable | Per-agent PVC + emptyDir `/tmp`; `readOnlyRootFilesystem: true` |

**What NemoClaw provides that this design does not (yet):**
- Per-binary network rules (requires Cilium or similar L7-aware CNI)
- Real-time operator approval for new network destinations
- Dynamic policy updates without pod restart

**What this design provides that NemoClaw does not:**
- Per-agent isolation (NemoClaw is per-gateway only)
- Kubernetes-native lifecycle (scale-to-zero, warm pools, scheduled expiry)
- Kata VM isolation (hardware-level boundary vs container + LSM)
- Multi-cluster/multi-namespace agent federation via A2A

---

## Appendix: NemoClaw Policy Reference

The following is the network policy structure from NemoClaw's `openclaw-sandbox.yaml`, adapted as a reference for designing Kubernetes NetworkPolicy rules:

| NemoClaw Policy Group | Allowed Endpoints | Kubernetes Equivalent |
|----------------------|-------------------|---------------------|
| `claude_code` | `api.anthropic.com:443`, `statsig.anthropic.com:443`, `sentry.io:443` | Egress to these IPs on port 443 (resolve at deploy time) |
| `nvidia` | `integrate.api.nvidia.com:443`, `inference-api.nvidia.com:443` | Egress to NVIDIA IPs on port 443 |
| `github` | `github.com:443`, `api.github.com:443` | Egress to GitHub IPs on port 443 |
| `telegram` | `api.telegram.org:443` | Egress to Telegram IPs on port 443 |

**Note:** Kubernetes NetworkPolicy does not support hostname-based rules -- only IP-based `ipBlock.cidr`. For hostname-based egress control, consider:
- Resolve hostnames at deploy time and inject as `ipBlock` rules
- Use Cilium `CiliumNetworkPolicy` with FQDN-based egress rules
- Use OpenShift `EgressNetworkPolicy` for domain-based filtering
