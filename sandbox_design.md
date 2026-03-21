# Per-Human Sandbox Isolation for OpenClaw on OpenShift

> Design document for running each human user's OpenClaw instance in an isolated Agent Sandbox pod with defense-in-depth security, informed by NVIDIA NemoClaw's security model and the Kubernetes Agent Sandbox operator.

**Status:** Proposal
**Author:** RB
**Date:** 2026-03-21
**Related:**
- [Agent Sandbox (kubernetes-sigs)](https://agent-sandbox.sigs.k8s.io/)
- [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw) / [Docs](https://docs.nvidia.com/nemoclaw/latest/)
- [Google Cloud: Isolate AI code execution with Agent Sandbox](https://cloud.google.com/kubernetes-engine/docs/how-to/agent-sandbox)

---

## 1. Core Principle

**OpenClaw agents own the computer they run on.** An agent can read any file, run any process, and access any resource on its machine -- bare metal, VM, or container. Security comes from controlling **what that machine can reach on the network** and **who else shares it**, not from restricting the agent inside the machine.

This is the same model [NVIDIA NemoClaw](https://github.com/NVIDIA/NemoClaw) uses: the entire gateway is one sandbox. Isolation is between sandboxes (between humans), not within them (between agents).

## 2. Problem Statement

OpenClaw on OpenShift already uses per-user namespaces (`<prefix>-openclaw`). Each user gets their own gateway pod, PVC, secrets, and network space. But the current `Deployment`-based model lacks:

- **Resource efficiency at scale** -- 100 users = 100 pods running 24/7, most idle
- **Fast onboarding** -- New users wait for image pull + init container + readiness (~60-90s)
- **Hardware isolation** -- Users share the same kernel via `runc`; container escape = access to other users' data
- **Network control** -- No `NetworkPolicy`; a compromised gateway can reach any endpoint in the cluster or internet
- **Lifecycle management** -- No automatic expiry for demo/trial users; no scale-to-zero for idle users
- **Standardized provisioning** -- Each user's pod is created from raw templates; no reusable blueprint

## 3. Current Architecture

```
   setup.sh creates per-user namespace + Sandbox CR

   raghu-openclaw namespace                    sally-openclaw namespace
┌─────────────── Sandbox: openclaw ──────┐  ┌─────────────── Sandbox: openclaw ──────┐
│                                        │  │                                        │
│  ┌──────────┐ ┌─────────┐ ┌────────┐  │  │  ┌──────────┐ ┌─────────┐ ┌────────┐  │
│  │ oauth-   │ │ gateway │ │ agent- │  │  │  │ oauth-   │ │ gateway │ │ agent- │  │
│  │ proxy    │ │ (agents │ │ card   │  │  │  │ proxy    │ │ (agents │ │ card   │  │
│  │          │ │  run    │ │ (A2A)  │  │  │  │          │ │  run    │ │ (A2A)  │  │
│  │          │ │  here)  │ │        │  │  │  │          │ │  here)  │ │        │  │
│  └──────────┘ └────┬────┘ └────────┘  │  │  └──────────┘ └────┬────┘ └────────┘  │
│                    │                  │  │                    │                  │
│               ┌────┴────┐             │  │               ┌────┴────┐             │
│               │ PVC     │             │  │               │ PVC     │             │
│               │ (owned) │             │  │               │ (owned) │             │
│               └─────────┘             │  │               └─────────┘             │
│                                        │  │                                        │
│  No NetworkPolicy                      │  │  No NetworkPolicy                      │
│  No lifecycle controls                 │  │  No lifecycle controls                 │
│  runc runtime (shared kernel)          │  │  runc runtime (shared kernel)          │
└────────────────────────────────────────┘  └────────────────────────────────────────┘
```

**What works:** Each user already has their own pod, PVC, secrets, and agents. Agents within a user's pod share process/memory/filesystem, but that's fine -- they all belong to the same human.

**What's missing:** The surrounding infrastructure for scale, security, and lifecycle.

## 4. Industry Context

### 4.1 NVIDIA NemoClaw (Workstation Pattern)

NemoClaw wraps the entire OpenClaw gateway in an [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sandbox:

| Layer | Mechanism | What It Controls |
|-------|-----------|-----------------|
| **Network** | Default-deny egress with per-binary allowlists | Which hosts each binary can reach |
| **Filesystem** | Landlock LSM + container FS | `/sandbox` + `/tmp` writable; everything else read-only |
| **Process** | seccomp + netns + dedicated user | No privilege escalation, restricted syscalls |
| **Inference** | Gateway-intercepted routing | All LLM calls proxied through controlled backend |

**Key insight from NemoClaw:** The sandbox IS the gateway. All agents in the gateway share the sandbox. The isolation boundary is between gateways (between users), not between agents. This design applies the same principle using Kubernetes-native mechanisms.

### 4.2 Kubernetes Agent Sandbox (Cluster Pattern)

The [kubernetes-sigs/agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) operator provides:

- `Sandbox` CR: singleton stateful pod with stable identity and persistent storage
- `SandboxTemplate`: reusable pod blueprints with built-in `NetworkPolicy` support and `networkPolicyManagement` (Managed/Unmanaged)
- `SandboxClaim`: user/automation requests a sandbox from a template, with optional `lifecycle.shutdownTime` for auto-expiry
- `SandboxWarmPool`: pre-warmed pods for instant allocation (supports HPA on `spec.replicas`)
- Runtime class support: gVisor (GKE default) or Kata Containers (OpenShift)
- Status: `serviceFQDN` published automatically for each Sandbox

**Cluster state:** Agent Sandbox controller v0.2.1 is running on the target OpenShift cluster with all 4 CRDs registered and extensions enabled. Kata RuntimeClass is available on all nodes.

## 5. Proposed Architecture

Each human gets a `SandboxClaim` from a shared `SandboxTemplate`. The template defines the pod spec, NetworkPolicy, and (optionally) Kata runtime. A `SandboxWarmPool` keeps pre-warmed instances ready for instant allocation.

```
                   SandboxTemplate: openclaw-user
                   ├── Pod spec (gateway + oauth-proxy + agent-card + init-config)
                   ├── NetworkPolicy (default-deny egress + allowlist)
                   └── Kata RuntimeClass (optional)
                            │
              ┌─────────────┼──────────────┬───────────────┐
              │             │              │               │
              ▼             ▼              ▼               ▼
        SandboxClaim:  SandboxClaim:  SandboxClaim:  SandboxWarmPool:
        raghu          sally          bob            openclaw-warmpool
              │             │              │               │
              ▼             ▼              ▼               ▼
        ┌──────────┐  ┌──────────┐  ┌──────────┐   ┌──────────┐
        │ Sandbox  │  │ Sandbox  │  │ Sandbox  │   │ 3 warm   │
        │ pod      │  │ pod      │  │ pod      │   │ pods     │
        │ (raghu's │  │ (sally's │  │ (bob's   │   │ (ready   │
        │  agents) │  │  agents) │  │  agents) │   │  to      │
        │          │  │          │  │          │   │  adopt)   │
        │ PVC      │  │ PVC      │  │ PVC      │   │          │
        └──────────┘  └──────────┘  └──────────┘   └──────────┘
              │             │              │
         NetworkPolicy  NetworkPolicy  NetworkPolicy
         (shared, per-template, auto-managed by controller)
```

### 5.1 What Each User Gets

Every user's Sandbox pod is identical to what `setup.sh` deploys today:

| Component | Purpose |
|-----------|---------|
| `oauth-proxy` container | OpenShift authentication |
| `gateway` container | Node.js OpenClaw gateway with all user's agents |
| `agent-card` container | A2A bridge for Kagenti |
| `init-config` init container | Seeds config from ConfigMap to PVC |
| PVC | Persistent workspace, session transcripts, agent data |
| Secrets | User-specific API keys, gateway token |

Agents within the pod share process, memory, filesystem, and secrets. This is intentional -- they all belong to the same human. The agent "owns" its computer.

### 5.2 Security Layers (NemoClaw-Inspired)

| Layer | Implementation on OpenShift |
|-------|---------------------------|
| **Network** | `SandboxTemplate.spec.networkPolicy` with default-deny egress; allow only DNS + model API endpoints + cluster services |
| **Filesystem** | Per-user PVC; `readOnlyRootFilesystem: true` on all containers; no cross-user filesystem access |
| **Process** | Kata RuntimeClass (VM-level isolation between users); `runAsNonRoot: true`; `allowPrivilegeEscalation: false` |
| **Secrets** | Per-user secrets in per-user namespace; no shared secrets across users |
| **Lifecycle** | `SandboxClaim.lifecycle.shutdownTime` for auto-expiry; scale-to-zero for idle users |

### 5.3 Scale Model

| Scenario | Mechanism |
|----------|-----------|
| **100 humans, 100 pods** | Each user has a SandboxClaim; controller manages pods |
| **80 idle, 20 active** | Idle users scaled to zero (`spec.replicas: 0`); PVC preserved; 80% resource savings |
| **New user onboards** | SandboxClaim adopts a pre-warmed pod from WarmPool; ready in seconds, not minutes |
| **Trial expires** | `lifecycle.shutdownTime` on SandboxClaim; controller auto-deletes when reached |
| **User returns after idle** | Scale back to 1; init container re-seeds config from ConfigMap; PVC data intact |

## 6. Implementation Phases

### Phase 1: SandboxTemplate + NetworkPolicy

Create the `SandboxTemplate` that defines how user sandboxes are provisioned. The pod spec is derived directly from the existing `openclaw-sandbox.yaml.envsubst`.

**New files:**

`platform/agent-sandbox/openclaw-user-template.yaml.envsubst`:

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxTemplate
metadata:
  name: openclaw-user
  namespace: ${OPENCLAW_NAMESPACE}
spec:
  podTemplate:
    metadata:
      labels:
        app: openclaw
        kagenti.io/type: agent
        kagenti.io/protocol: a2a
        kagenti.io/inject: ${KAGENTI_INJECT:-disabled}
      annotations:
        prometheus.io/scrape: 'true'
        prometheus.io/port: '18789'
        sidecar.opentelemetry.io/inject: "openclaw-sidecar"
    spec:
      serviceAccountName: openclaw-oauth-proxy
      initContainers:
      - name: init-config
        image: registry.redhat.io/ubi9-minimal:latest
        imagePullPolicy: IfNotPresent
        resources:
          requests:
            memory: 64Mi
            cpu: 50m
          limits:
            memory: 128Mi
            cpu: 200m
        command:
        - sh
        - -c
        - |
          cp /config/openclaw.json /home/node/.openclaw/openclaw.json
          chmod 644 /home/node/.openclaw/openclaw.json
          mkdir -p /home/node/.openclaw/workspace
          mkdir -p /home/node/.openclaw/skills
          mkdir -p /home/node/.openclaw/cron
          mkdir -p /home/node/.openclaw/agents
          grep -o '"id": *"[^"]*"' /config/openclaw.json | \
            sed 's/"id": *"//;s/"$//' | while read agent_id; do
            mkdir -p "/home/node/.openclaw/agents/$agent_id/sessions"
          done
          if [ ! -f /home/node/.openclaw/workspace/AGENTS.md ]; then
            cp /agents/shadowman/AGENTS.md /home/node/.openclaw/workspace/AGENTS.md 2>/dev/null || true
            cp /agents/shadowman/agent.json /home/node/.openclaw/workspace/agent.json 2>/dev/null || true
          fi
          chgrp -R 0 /home/node/.openclaw
          chmod -R g=u /home/node/.openclaw
        volumeMounts:
        - name: openclaw-home
          mountPath: /home/node/.openclaw
        - name: config-template
          mountPath: /config
        - name: shadowman-agent
          mountPath: /agents/shadowman
      containers:
      - name: gateway
        image: ${OPENCLAW_IMAGE}
        imagePullPolicy: Always
        command: ["node", "/app/dist/index.js", "gateway", "run",
                  "--bind", "loopback", "--port", "18789", "--verbose"]
        ports:
        - name: gateway
          containerPort: 18789
        - name: bridge
          containerPort: 18790
        env:
        - name: HOME
          value: /home/node
        - name: OPENCLAW_CONFIG_DIR
          value: /home/node/.openclaw
        - name: OPENCLAW_STATE_DIR
          value: /home/node/.openclaw
        - name: NODE_OPTIONS
          value: "--max-old-space-size=1536"
        - name: NODE_ENV
          value: production
        - name: OPENCLAW_GATEWAY_TOKEN
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: OPENCLAW_GATEWAY_TOKEN
        - name: ANTHROPIC_API_KEY
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: ANTHROPIC_API_KEY
              optional: true
        - name: GOOGLE_AI_API_KEY
          valueFrom:
            secretKeyRef:
              name: openclaw-secrets
              key: GOOGLE_AI_API_KEY
              optional: true
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
        - name: openclaw-home
          mountPath: /home/node/.openclaw
        - name: tmp-volume
          mountPath: /tmp
      volumes:
      - name: tmp-volume
        emptyDir: {}
      - name: openclaw-home
        persistentVolumeClaim:
          claimName: openclaw-home-pvc
      - name: config-template
        configMap:
          name: openclaw-config
      - name: shadowman-agent
        configMap:
          name: shadowman-agent
          optional: true

  # NemoClaw-inspired: default-deny with explicit allowlist
  networkPolicy:
    ingress:
    # OpenShift Router / Ingress controller
    - from:
      - namespaceSelector:
          matchLabels:
            network.openshift.io/policy-group: ingress
    egress:
    # DNS resolution
    - ports:
      - protocol: UDP
        port: 53
      - protocol: TCP
        port: 53
    # LLM model APIs (HTTPS)
    - ports:
      - protocol: TCP
        port: 443
    # In-cluster model endpoint (vLLM, etc.)
    - to:
      - namespaceSelector: {}
        podSelector:
          matchLabels:
            app: vllm
      ports:
      - protocol: TCP
        port: 8000
    # OTEL collector
    - ports:
      - protocol: TCP
        port: 4317
      - protocol: TCP
        port: 4318
```

`platform/agent-sandbox/sandbox-rbac.yaml.envsubst`:

```yaml
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

`platform/agent-sandbox/kustomization.yaml`:

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
- openclaw-user-template.yaml
- sandbox-rbac.yaml
```

**Validation:**
- Apply the SandboxTemplate to the cluster
- Verify the controller creates a shared NetworkPolicy with default-deny posture
- Create a test SandboxClaim and confirm pod creation + headless Service DNS

---

### Phase 2: WarmPool + Lifecycle

Pre-warm pods for fast user onboarding. Add lifecycle controls for trial users.

**New file:** `platform/agent-sandbox/openclaw-warmpool.yaml.envsubst`:

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxWarmPool
metadata:
  name: openclaw-warmpool
  namespace: ${OPENCLAW_NAMESPACE}
spec:
  replicas: 3
  sandboxTemplateRef:
    name: openclaw-user
```

**Lifecycle usage** (in `setup.sh` when provisioning a trial user):

```yaml
apiVersion: extensions.agents.x-k8s.io/v1alpha1
kind: SandboxClaim
metadata:
  name: trial-user-alice
  namespace: ${OPENCLAW_NAMESPACE}
spec:
  sandboxTemplateRef:
    name: openclaw-user
  lifecycle:
    shutdownTime: "2026-04-21T00:00:00Z"  # 30-day trial
    shutdownPolicy: Retain                  # keep PVC, delete pod
```

**Validation:**
- Create WarmPool; verify 3 pods pre-warmed and `readyReplicas: 3` in status
- Create SandboxClaim; verify it adopts a warm pod (instant Ready)
- Verify `shutdownTime` triggers cleanup when reached

---

### Phase 3: Integrate with setup.sh

Modify `setup.sh` to create `SandboxClaim` + user-specific resources instead of raw `Sandbox` CRs.

**Modified files:**

`scripts/setup.sh`:
1. Apply the `SandboxTemplate` (from `platform/agent-sandbox/`) before user provisioning
2. For each user, create:
   - Per-user namespace (already done)
   - Per-user ConfigMap (`openclaw-config`) and Secrets (`openclaw-secrets`)
   - `SandboxClaim` referencing `openclaw-user` template
3. Wait for `SandboxClaim` condition `Ready`
4. Seed workspace via `kubectl exec` into the claimed pod

`scripts/setup-agents.sh`:
1. Resolve the pod name from the SandboxClaim's status
2. Seed agent workspaces into the user's pod via `kubectl exec` (unchanged logic)

**No changes needed to:**
- `add-agent.sh` -- Agents are added to the user's existing pod, not to separate pods
- `export-config.sh` -- Still targets the user's pod via label selector
- `update-jobs.sh` -- CronJobs write reports to ConfigMaps; gateway reads them from volume mounts

---

### Phase 4: Kata Runtime (Optional)

Add VM-level isolation between users via Kata Containers.

**Constraint:** The full OpenClaw pod (3 containers + 1 init container + 11 volume mounts) exceeds Kata's default sandbox creation timeout. Two options:

**Option A: Simplified pod spec for Kata**

Create a second `SandboxTemplate` (`openclaw-user-kata`) with a stripped-down pod spec:
- Single `gateway` container (no oauth-proxy, no agent-card)
- 2-3 volume mounts only (PVC + config + tmp)
- Ingress via cluster-level ingress controller instead of oauth-proxy sidecar

**Option B: Tune Kata timeout**

Increase `sandbox_creation_timeout` in the Kata TOML configuration on worker nodes. This requires node-level access and cluster-admin privileges. Validate on a test node first.

**Recommendation:** Start with runc (Phase 1-3). Add Kata for high-security tenants in Phase 4 using Option A (simplified template). The NetworkPolicy + per-namespace isolation provides strong defense-in-depth even without Kata.

---

## 7. File Change Summary

| Phase | Action | File | Description |
|-------|--------|------|-------------|
| 1 | CREATE | `platform/agent-sandbox/openclaw-user-template.yaml.envsubst` | SandboxTemplate with full pod spec + NetworkPolicy |
| 1 | CREATE | `platform/agent-sandbox/sandbox-rbac.yaml.envsubst` | RBAC for SandboxClaim management |
| 1 | CREATE | `platform/agent-sandbox/kustomization.yaml` | Kustomize config |
| 2 | CREATE | `platform/agent-sandbox/openclaw-warmpool.yaml.envsubst` | WarmPool for instant user onboarding |
| 3 | MODIFY | `scripts/setup.sh` | Create SandboxClaim instead of raw Sandbox CR |
| 3 | MODIFY | `scripts/setup-agents.sh` | Resolve pod from SandboxClaim status |
| ALL | MODIFY | `CLAUDE.md` | Document the architecture |

## 8. Security Comparison

| Threat | Current (Sandbox CR, no NetworkPolicy) | This Design (SandboxTemplate + NetworkPolicy) |
|--------|----------------------------------------|-----------------------------------------------|
| User A's agent reads User B's data | **Blocked** (separate namespaces/PVCs) | **Blocked** (separate namespaces/PVCs) |
| User A's agent steals User B's API keys | **Blocked** (separate secrets) | **Blocked** (separate secrets) |
| Agent makes arbitrary network calls | **Possible** (no NetworkPolicy) | **Blocked** (default-deny egress, explicit allowlist) |
| Agent reaches cluster-internal services | **Possible** (flat network) | **Blocked** (egress restricted to DNS + model APIs) |
| Container escape → host access | **Possible** (runc, shared kernel) | **Blocked** with Kata (VM boundary); mitigated without |
| 100 idle pods waste resources | **Yes** (always running) | **No** (scale-to-zero, WarmPool) |
| Slow onboarding for new users | **Yes** (~60-90s cold start) | **No** (WarmPool instant adoption) |
| Trial user cleanup | **Manual** | **Automatic** (`lifecycle.shutdownTime`) |

## 9. What This Design Intentionally Does NOT Do

### Per-agent isolation

Agents within a user's pod share process, memory, filesystem, and secrets. This is by design:

- All agents belong to the same human -- there is no trust boundary between them
- OpenClaw agents are in-process identities inside a single Node.js gateway, not separate executables
- Splitting agents into separate pods would require solving inter-pod communication (HTTP, shared filesystem, config synchronization) with no security benefit for a single-user deployment
- NemoClaw takes the same approach: one sandbox per gateway, agents share it

If per-agent isolation is needed in the future (e.g., multi-tenant shared gateways), it would require running separate OpenClaw gateway instances -- one per agent -- in separate Sandbox pods. That architecture is documented separately as an aspirational direction.

### Per-binary network rules

NemoClaw can restrict which network endpoints each binary can reach (e.g., `claude` can reach `api.anthropic.com`; `gh` can reach `github.com`). Kubernetes NetworkPolicy operates at the pod level, not per-binary. For finer-grained control, consider Cilium `CiliumNetworkPolicy` with L7 rules or OpenShift `EgressNetworkPolicy` with FQDN-based filtering.

## 10. Relationship to NemoClaw

This design adapts NemoClaw's security philosophy for Kubernetes, at the same granularity NemoClaw uses (per-gateway, not per-agent):

| NemoClaw Concept | This Design's Equivalent |
|-----------------|------------------------|
| OpenShell sandbox | SandboxClaim → Sandbox CR (Kubernetes-native) |
| `openclaw-sandbox.yaml` policy | `SandboxTemplate.spec.networkPolicy` |
| Per-binary network rules | Not available in K8s NetworkPolicy (future: Cilium L7) |
| Operator TUI approval flow | Not implemented (static policy) |
| Landlock + seccomp | Kata VM isolation (stronger boundary) or runc + securityContext |
| `/sandbox` + `/tmp` writable | Per-user PVC + emptyDir `/tmp`; `readOnlyRootFilesystem: true` |

**What this design adds beyond NemoClaw:**
- Kubernetes-native lifecycle (scale-to-zero, warm pools, scheduled expiry)
- Multi-user provisioning from a single template
- Kata VM isolation (hardware boundary between users)
- Multi-cluster agent federation via A2A / Kagenti

## 11. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Kata times out with full OpenClaw pod spec | Confirmed | Medium | Use runc by default; offer simplified Kata template for high-security tenants |
| SandboxTemplate NetworkPolicy too restrictive | Medium | Medium | Start with egress to port 443 (all HTTPS); tighten incrementally |
| WarmPool pre-warmed pods consume idle resources | Low | Low | Set `replicas` based on expected onboarding rate; HPA supported |
| Agent Sandbox controller v0.2.1 is alpha | Medium | High | Option A already validates basic Sandbox CR functionality on this cluster |
| Per-user namespaces require cluster-admin for provisioning | Low | Low | Already the model in `setup.sh`; no change needed |
| Scale-to-zero loses in-memory agent state | Medium | Low | Agents are stateless between sessions; PVC preserves all persistent data |

## 12. Testing Plan

| Test | Phase | Method |
|------|-------|--------|
| SandboxTemplate creates NetworkPolicy | 1 | Apply template; verify `kubectl get networkpolicy` shows default-deny |
| NetworkPolicy blocks unauthorized egress | 1 | `curl http://internal-service:8080` from sandbox pod (should fail) |
| NetworkPolicy allows model API egress | 1 | `curl https://api.anthropic.com` from sandbox pod (should succeed) |
| SandboxClaim creates pod from template | 1 | Create claim; verify pod Running with correct spec |
| WarmPool pre-warms pods | 2 | Create WarmPool; verify `readyReplicas` matches `replicas` |
| SandboxClaim adopts warm pod | 2 | Create claim; measure time-to-Ready (expect < 5s) |
| Lifecycle auto-expires claim | 2 | Create claim with `shutdownTime` 2 min from now; verify pod deleted |
| setup.sh creates SandboxClaim | 3 | Run `setup.sh`; verify claim + pod + config seeded |
| Scale-to-zero preserves PVC | 3 | Set `replicas: 0`; set `replicas: 1`; verify workspace files intact |

---

## Appendix: NemoClaw Policy Reference

Network policy structure from NemoClaw's `openclaw-sandbox.yaml`, adapted as reference for Kubernetes NetworkPolicy rules:

| NemoClaw Policy Group | Allowed Endpoints | Kubernetes Equivalent |
|----------------------|-------------------|---------------------|
| `claude_code` | `api.anthropic.com:443`, `statsig.anthropic.com:443` | Egress port 443 (pod-level, all HTTPS) |
| `nvidia` | `integrate.api.nvidia.com:443` | Egress port 443 |
| `github` | `github.com:443`, `api.github.com:443` | Egress port 443 |
| `telegram` | `api.telegram.org:443` | Egress port 443 |

**Note:** Kubernetes NetworkPolicy does not support hostname-based rules -- only IP-based `ipBlock.cidr`. The template uses port-based egress (allow port 443) as a practical default. For hostname-based filtering:
- Cilium `CiliumNetworkPolicy` with FQDN-based egress rules
- OpenShift `EgressNetworkPolicy` for domain-based filtering
- Resolve hostnames at deploy time and inject as `ipBlock` rules
