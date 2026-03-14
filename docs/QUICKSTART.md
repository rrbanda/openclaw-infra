# Deploy OpenClaw on OpenShift in 5 Minutes

OpenClaw is an open-source AI agent gateway — a platform for running, managing, and observing AI agents.
This guide gets you from zero to a running OpenClaw instance on OpenShift, with OpenShift OAuth protecting the
UI and enterprise security hardening out of the box.

> For the full step-by-step walkthrough with expected output and troubleshooting, see [OPENSHIFT-WALKTHROUGH.md](OPENSHIFT-WALKTHROUGH.md).

## Why OpenShift?

OpenClaw runs on any Kubernetes cluster, but OpenShift adds layers of security that matter when you're
running AI agents that can call tools, execute code, and interact with external services.

### What OpenShift gives you for free

**OAuth integration** — OpenClaw's deployment includes an [oauth-proxy](https://github.com/openshift/oauth-proxy)
sidecar that authenticates users against OpenShift's built-in OAuth server. No external identity provider to configure.
If you can `oc login`, you can access your agent. The gateway binds to loopback only and uses `auth.mode: "token"` — the
OAuth proxy handles external authentication, and you enter the gateway token once in the UI (stored in browser localStorage).
This also enables internal agent-to-agent messaging via `sessions_send`.

**Security Context Constraints (SCCs)** — OpenShift's default `restricted-v2` SCC enforces a strict posture on every container:

- Runs as a random, non-root UID assigned by the namespace
- Read-only root filesystem
- All Linux capabilities dropped
- No privilege escalation

The OpenClaw gateway runs happily under `restricted-v2` with no custom SCC required. Every container in the pod — gateway,
oauth-proxy, and init-config — runs unprivileged with `allowPrivilegeEscalation: false`
and `capabilities.drop: [ALL]`.

**Routes with TLS** — OpenShift Routes provide automatic TLS termination via the cluster's wildcard certificate. The gateway listens on loopback only (`127.0.0.1:18789`) — all external traffic goes through the oauth-proxy, which handles authentication before forwarding to the gateway.

### The pod architecture

```
    Browser ──HTTPS──► OpenShift Route (TLS edge)
                              │
                              ▼ targetPort: oauth-ui (8443)
                       ┌─────────────┐
                       │ oauth-proxy │ ◄── OpenShift OAuth
                       │  (port 8443)│     authenticates user
                       └──────┬──────┘
                              │ proxies to gateway
                              ▼ http://localhost:18789
                       ┌─────────────┐
                       │   gateway   │ ◄── bind: loopback
                       │ (port 18789)│     auth: token
                       └─────────────┘     read-only root
                       ┌─────────────┐     all caps dropped
                       │ init-config │ ◄── runs at start
                       │ (init cont) │     copies config → PVC
                       └─────────────┘

         PVC (/home/node/.openclaw)
           Config, sessions, agent workspaces
```

All containers run under `restricted-v2`. No custom SCC. No cluster-admin for the workload itself.

### What the platform deploys

| Resource | Purpose |
|----------|---------|
| **ResourceQuota** | Caps the namespace at 4 CPU / 8Gi RAM requests, 20 pods, 100Gi storage |
| **PodDisruptionBudget** | `maxUnavailable: 0` — protects the pod during node maintenance |
| **ServiceAccount** | Dedicated SA for the oauth-proxy with read-only cluster access |
| **OAuthClient** | Cluster-scoped — registers the instance with OpenShift's OAuth server |
| **Role/RoleBinding** | Namespace-scoped read access for the agent to query K8s resources |
| **ClusterRole/ClusterRoleBinding** | Cross-namespace read access for deployments, pods, namespaces |

## Prerequisites

- An OpenShift cluster (4.x) where you can create a namespace
- `oc` CLI authenticated (`oc login`)
- An API key for at least one model provider (see [Model options](#model-options))

The OAuthClient and ClusterRoleBinding are cluster-scoped resources. If you don't have cluster-admin, the script
will print the exact commands to give your admin.

## Deploy

```bash
git clone https://github.com/redhat-et/openclaw-k8s.git
cd openclaw-k8s
./scripts/setup.sh
```

The script is interactive. It will prompt you for:

1. **Namespace prefix** — your name or team (e.g., `alice`). Creates the namespace `alice-openclaw`.
2. **Agent name** — a display name for your default agent (e.g., `Atlas`, `Scout`, `Raven`).
3. **Anthropic API key** — optional, for Claude models. Leave empty to skip.
4. **Google AI API key** — optional, for Gemini models via [Google AI Studio](https://aistudio.google.com/app/apikey). Leave empty to skip.
5. **Model endpoint** — for in-cluster models. Press Enter for the default vLLM URL.

Everything else is auto-generated (gateway token, OAuth secrets, cookie secrets) and saved to `.env` (git-ignored).

The script builds a `generated/` directory with processed templates, deploys via kustomize, waits for the pod to be
ready, and installs agent workspace files. Total time: about 2 minutes, most of it waiting for the image pull.

## Access your instance

The Route URL is printed at the end of setup:

```
Access URLs:
  OpenClaw Gateway:   https://openclaw-alice-openclaw.apps.your-cluster.example.com
```

Open the URL in your browser. OpenShift OAuth handles authentication — you'll be redirected to the OpenShift login page.
After authenticating, the Control UI loads and prompts for the gateway token. The token is printed at the end of `setup.sh`
output and saved in `.env`. Enter it once — it's stored in browser localStorage for future visits.

```bash
# Get your gateway token
grep OPENCLAW_GATEWAY_TOKEN .env
```

## What you get

A running OpenClaw gateway with:

- **Your named agent** — an interactive AI agent backed by the model provider you configured
- **Control UI** — agent management, session history, configuration
- **Cluster access** — the agent can query Kubernetes resources in your namespace and across the cluster (read-only)

### Talk to your agent

Select your agent in the sidebar and start chatting. The agent has access to the
tools configured in your gateway — by default, a general-purpose assistant backed by your chosen model.

Try asking: *"What apps are deployed on this cluster?"* — the agent will query the Kubernetes API and list deployments.

### Create your own agent

Scaffold and deploy a new agent end-to-end:

```bash
./scripts/add-agent.sh
```

## Model options

The setup script supports multiple model providers. You can also change models after deployment by editing the config.

| Provider | Model | How to configure |
|----------|-------|-----------------|
| Anthropic | `anthropic/claude-sonnet-4-6` | `ANTHROPIC_API_KEY` env var or interactive prompt |
| Google AI Studio | `google/gemini-2.5-flash` | `GOOGLE_AI_API_KEY` env var or interactive prompt |
| Google Vertex AI | `google-vertex/gemini-2.5-pro` | `--vertex` flag, requires GCP project |
| Claude via Vertex | `anthropic-vertex/claude-sonnet-4-6` | `--vertex --vertex-provider anthropic` |
| In-cluster vLLM | Any model on your GPU node | Set `MODEL_ENDPOINT` to your vLLM `/v1` URL |

**Model priority:** Anthropic > Google AI Studio > Vertex > in-cluster. The first available key wins.

## Known issues

| Issue | Cause | Resolution |
|-------|-------|------------|
| Google AI Studio returns 400 errors | OpenClaw sends `thinking` or `store` parameters that Gemini doesn't support | Already handled by config: `thinkingDefault: off` and `compat.supportsStore: false` |
| Agent says "jq isn't installed" | The container image does not include `jq` | Agent is configured to use `node -e` for JSON processing instead |
| Agent says "oc isn't available" | The container image does not include `oc` | Agent uses `curl` + ServiceAccount token to query the K8s API directly |
| Stale agent behavior after model changes | Old sessions cache model parameters | Restart the pod: `oc rollout restart deployment/openclaw -n <namespace>` |

## Teardown

```bash
./scripts/teardown.sh
```

Removes the namespace, all resources, the OAuthClient, cluster RBAC, and the `generated/` directory.
Your `.env` is kept unless you pass `--delete-env`.

## Next steps

| What | How |
|------|-----|
| Full deployment walkthrough | [OPENSHIFT-WALKTHROUGH.md](OPENSHIFT-WALKTHROUGH.md) |
| Create a custom agent | `./scripts/add-agent.sh` (scaffolds, deploys, and restarts — end to end) |
| Save live config | `./scripts/export-config.sh` (exports live `openclaw.json` from running pod) |
| Re-deploy safely | `./scripts/setup.sh` detects config drift and prompts to preserve |
| Add scheduled jobs | Create a `JOB.md` in your agent directory, run `./scripts/update-jobs.sh` |
| Enable observability | `./scripts/deploy-otelcollector.sh` (requires OTEL Operator + MLflow) |
| Enable zero-trust A2A | Redeploy with `./scripts/setup.sh --with-a2a` (requires [Kagenti](https://github.com/kagenti/kagenti)) |

## Links

- **Repository**: [github.com/redhat-et/openclaw-k8s](https://github.com/redhat-et/openclaw-k8s)
- **OpenClaw**: [github.com/openclaw](https://github.com/openclaw)
- **Kagenti** (zero-trust A2A): [github.com/kagenti/kagenti](https://github.com/kagenti/kagenti)
