# OpenClaw on OpenShift — Full Deployment Walkthrough

A step-by-step guide to deploying OpenClaw on an OpenShift cluster. Every command includes its expected
output so you can verify each step succeeded before moving on.

> For a shorter overview, see [QUICKSTART.md](QUICKSTART.md).

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Clone and Deploy](#2-clone-and-deploy)
3. [First Access](#3-first-access)
4. [Verify the Agent Works](#4-verify-the-agent-works)
5. [What Got Deployed](#5-what-got-deployed)
6. [Configuration Reference](#6-configuration-reference)
7. [Troubleshooting](#7-troubleshooting)
8. [Teardown](#8-teardown)
9. [Known Issues and Limitations](#9-known-issues-and-limitations)

---

## 1. Prerequisites

### OpenShift cluster

You need an OpenShift 4.x cluster where you can create namespaces. The setup script creates an OAuthClient
(cluster-scoped), so cluster-admin access is ideal. If you don't have it, the script prints the exact
commands to give your cluster admin.

### oc CLI

Install and authenticate:

```bash
oc version
```

Expected output:

```
Client Version: 4.x.x
Kustomize Version: v5.x.x
Server Version: 4.x.x
```

```bash
oc whoami
```

Expected output:

```
admin    # or your username
```

### API key

You need an API key for at least one model provider:

- **Google AI Studio** (recommended for getting started): Get a free key at https://aistudio.google.com/app/apikey
- **Anthropic**: Get a key at https://console.anthropic.com/

---

## 2. Clone and Deploy

### Clone the repository

```bash
git clone https://github.com/redhat-et/openclaw-k8s.git
cd openclaw-k8s
```

### Run setup.sh

```bash
./scripts/setup.sh
```

The script is interactive. Here's what each prompt looks like and what to enter:

#### Prompt 1: Namespace prefix

```
Enter a unique prefix for your OpenClaw namespace (e.g., your name or team):
  This creates namespace: <prefix>-openclaw
  Prefix:
```

Enter your name or team name (e.g., `alice`). This creates the namespace `alice-openclaw` and prefixes
all agent IDs with `alice_`.

#### Prompt 2: Agent name

```
Name your default agent (display name, e.g., Atlas, Scout, Raven):
  Agent name:
```

Enter a name for your AI assistant (e.g., `Atlas`). This is purely cosmetic — it appears in the UI sidebar.

#### Prompt 3: Anthropic API key

```
Anthropic API key (for Claude models):
  Get a key at https://console.anthropic.com/settings/keys
  API key (leave empty to skip):
```

Paste your Anthropic key, or press Enter to skip if you're using Google AI Studio instead.

#### Prompt 4: Google AI API key

```
Google AI Studio API key (optional, for Gemini models):
  Get a key at https://aistudio.google.com/app/apikey
  API key (leave empty to skip):
```

Paste your Google AI Studio key, or press Enter to skip if you already entered an Anthropic key.

#### Prompt 5: Model endpoint

```
Model endpoint (OpenAI-compatible /v1 URL for in-cluster model):
  Default: http://vllm.openclaw-llms.svc.cluster.local/v1
  Endpoint (press Enter for default):
```

Press Enter to accept the default. This is only used if you have a vLLM instance running in the cluster.

### Expected output after setup completes

The script takes about 2 minutes. You'll see milestones like:

```
✅ Namespace created: alice-openclaw (owner: alice, agent: Atlas)
✅ OpenClaw OAuthClient created
✅ ClusterRole/ClusterRoleBinding openclaw-cluster-viewer applied
ℹ️  Using Google AI Studio (Gemini 2.5 Flash) as default agent model
✅ OpenClaw deployed via kustomize (openshift overlay)
⏳ Waiting for pod to be ready...
✅ Pod ready: openclaw-xxxxxxxxxx-xxxxx (3/3 containers)
✅ Agent workspace files installed (Atlas)
```

At the end:

```
═══════════════════════════════════════════════════════
  Access URLs:
  OpenClaw Gateway:   https://openclaw-alice-openclaw.apps.your-cluster.example.com
═══════════════════════════════════════════════════════
```

Copy this URL — you'll need it in the next step.

---

## 3. First Access

### Open the Route URL

Open the URL from the setup output in your browser.

**What you should see:** The browser redirects to the OpenShift login page. This is the OAuth proxy handling
authentication. Log in with your OpenShift credentials (the same ones you used for `oc login`).

### After login

**What you should see:** The OpenClaw Control UI loads automatically. You should see:

- Your agent name in the left sidebar (e.g., "Atlas")
- Connection status showing "Connected" (green)
- A chat input area at the bottom

**No gateway token is needed.** The OAuth proxy authenticates you via OpenShift and forwards your username
to the gateway via the `X-Forwarded-User` header. The gateway is configured in `trusted-proxy` mode and
accepts this header as authentication.

### If you see "Disconnected from gateway" or "device identity required"

This should not happen with the current templates. If it does, see [Troubleshooting](#7-troubleshooting).

---

## 4. Verify the Agent Works

### Test 1: Basic conversation

Click on your agent in the sidebar, then type in the chat:

```
Hello, what can you do?
```

**Expected:** The agent responds within a few seconds with a greeting and a description of its capabilities.
If using Google AI Studio, the response comes from Gemini 2.5 Flash.

### Test 2: Cluster access

Type in the chat:

```
What apps are deployed on this cluster?
```

**Expected:** The agent queries the Kubernetes API using `curl` and the ServiceAccount token, then responds
with a list of deployments grouped by namespace. System namespaces (`openshift-*`, `redhat-*`) are filtered
out. You should see at least your own namespace listed.

Example response:

```
Here are the applications deployed on the cluster:

alice-openclaw: openclaw

(additional namespaces and deployments if present)
```

### Test 3: Direct API verification (optional)

You can verify the gateway is responding directly:

```bash
ROUTE=$(oc get route openclaw -n alice-openclaw -o jsonpath='{.spec.host}')
curl -s -o /dev/null -w "%{http_code}" "https://$ROUTE"
```

**Expected:** `403` (OAuth proxy blocks unauthenticated access — this is correct behavior).

---

## 5. What Got Deployed

### Kubernetes resources

After setup, these resources exist in your namespace:

```bash
oc get all,configmap,secret,pvc,role,rolebinding -n alice-openclaw
```

| Resource | Name | Purpose |
|----------|------|---------|
| **Namespace** | `alice-openclaw` | Isolated environment for your OpenClaw instance |
| **Deployment** | `openclaw` | 3 containers: oauth-proxy, gateway, agent-card |
| **Service** | `openclaw` | ClusterIP service exposing ports 8443, 18789, 8080 |
| **Route** | `openclaw` | TLS-terminated external URL targeting oauth-proxy (port 8443) |
| **ConfigMap** | `openclaw-config` | Gateway configuration (models, tools, agents, auth) |
| **ConfigMap** | `shadowman-agent` | Agent workspace files (AGENTS.md, TOOLS.md, etc.) |
| **Secret** | `openclaw-secrets` | API keys, gateway token |
| **Secret** | `openclaw-oauth-config` | OAuth client secret, cookie secret |
| **PVC** | `openclaw-home-pvc` | Persistent storage for config, sessions, workspaces |
| **Role** | `openclaw-cluster-reader` | Read access to pods, deployments, services, etc. |
| **RoleBinding** | `openclaw-cluster-reader` | Binds Role to the ServiceAccount |
| **ServiceAccount** | `openclaw-oauth-proxy` | Runs the pod, used for K8s API queries |
| **ResourceQuota** | `openclaw-quota` | Limits namespace resource consumption |
| **PodDisruptionBudget** | `openclaw-pdb` | Protects pod during node maintenance |

Cluster-scoped resources (outside the namespace):

```bash
oc get oauthclient alice-openclaw
oc get clusterrolebinding openclaw-cluster-viewer-alice-openclaw
```

| Resource | Name | Purpose |
|----------|------|---------|
| **OAuthClient** | `alice-openclaw` | Registers with OpenShift's OAuth server |
| **ClusterRole** | `openclaw-cluster-viewer` | Cross-namespace read access |
| **ClusterRoleBinding** | `openclaw-cluster-viewer-alice-openclaw` | Binds ClusterRole to the ServiceAccount |

### Verify pod health

```bash
oc get pods -n alice-openclaw
```

**Expected:**

```
NAME                        READY   STATUS    RESTARTS   AGE
openclaw-xxxxxxxxxx-xxxxx   3/3     Running   0          5m
```

All 3 containers must be `Ready`. If you see `2/3` or `CrashLoopBackOff`, check the [Troubleshooting](#7-troubleshooting) section.

### Check gateway logs

```bash
oc logs deployment/openclaw -c gateway -n alice-openclaw --tail=10
```

**Expected:** You should see heartbeat messages and WebSocket events:

```
[ws] → event health seq=... clients=1 ...
[ws] → event tick seq=... clients=1 ...
[diagnostic] heartbeat: webhooks=0/0/0 active=0 ...
```

The key indicators: `clients=1` (a browser is connected) and no error messages.

---

## 6. Configuration Reference

### Where config lives

| Location | What | How to access |
|----------|------|---------------|
| `.env` | Local secrets (API keys, tokens) | `cat .env` (never commit this) |
| `generated/` | Processed templates | Created by `setup.sh`, git-ignored |
| ConfigMap `openclaw-config` | Gateway config on cluster | `oc get cm openclaw-config -n <ns> -o jsonpath='{.data.openclaw\.json}'` |
| PVC `/home/node/.openclaw/openclaw.json` | Live config in the pod | `oc exec <pod> -c gateway -- cat /home/node/.openclaw/openclaw.json` |

The init container copies from ConfigMap to PVC on every pod restart. The gateway reads the PVC copy at runtime.

### Change models after deployment

To switch models without re-running setup:

1. Export the live config: `./scripts/export-config.sh`
2. Edit the exported JSON (change `models.providers` or `agents.defaults.model`)
3. Redeploy: `./scripts/setup.sh --preserve-config`

### Add more agents

```bash
./scripts/add-agent.sh
```

This scaffolds a new agent from a template, creates its ConfigMap, installs workspace files, and restarts the pod.

---

## 7. Troubleshooting

### "device identity required" or "Disconnected from gateway"

**Cause:** The gateway doesn't recognize the connection as authenticated. This happens when:

- `gateway.auth.mode` is not set to `"trusted-proxy"`
- `gateway.auth.trustedProxy.userHeader` is missing or empty
- `gateway.trustedProxies` doesn't include loopback CIDRs
- The Route targets the gateway port (18789) instead of the OAuth proxy port (8443)

**Fix:** Verify the ConfigMap has the correct auth config:

```bash
oc get cm openclaw-config -n <namespace> -o jsonpath='{.data.openclaw\.json}' | python3 -m json.tool | grep -A5 '"auth"'
```

Expected:

```json
"auth": {
    "mode": "trusted-proxy",
    "trustedProxy": {
        "userHeader": "X-Forwarded-User"
    }
}
```

Also verify the Route targets the OAuth proxy:

```bash
oc get route openclaw -n <namespace> -o jsonpath='{.spec.port.targetPort}'
```

Expected: `oauth-ui`

### Agent says "Compacting context..." but never responds

**Cause:** The model API is returning errors. Check the logs:

```bash
oc logs deployment/openclaw -c gateway -n <namespace> --tail=50 | grep -i error
```

Common causes:

- `400 status code (no body)` — the model provider rejects a parameter. Already handled for Google AI Studio
  by `thinkingDefault: off` and `compat.supportsStore: false`. If you see this, verify these settings exist
  in the ConfigMap.
- Network errors — the pod can't reach the model provider. Check egress rules.

### Pod in CrashLoopBackOff

**Cause:** Check the gateway container logs:

```bash
oc logs deployment/openclaw -c gateway -n <namespace> --previous
```

Common causes:

- `gateway auth mode is trusted-proxy, but no trustedProxy config was provided` — the `gateway.auth.trustedProxy`
  object is missing. It must be at `gateway.auth.trustedProxy`, NOT at `gateway.trustedProxy`.
- `trustedProxy.userHeader is empty` — add `"userHeader": "X-Forwarded-User"` inside `gateway.auth.trustedProxy`.

### Agent can't query cluster resources

**Cause:** RBAC not applied, or the TOOLS.md doesn't have cluster access instructions.

Verify RBAC:

```bash
oc get role openclaw-cluster-reader -n <namespace>
oc get clusterrole openclaw-cluster-viewer
```

If missing, apply manually:

```bash
# The cluster-viewer RBAC file is in generated/ after running setup.sh
oc apply -f generated/agents/openclaw/base/openclaw-cluster-viewer-rbac.yaml
```

The namespace-scoped Role/RoleBinding should be created by kustomize automatically.

Verify TOOLS.md:

```bash
POD=$(oc get pod -n <namespace> -l app=openclaw -o jsonpath='{.items[0].metadata.name}')
oc exec $POD -c gateway -- cat /home/node/.openclaw/workspace-<prefix>_<agent_name>/TOOLS.md | head -5
```

Expected: should contain "Cluster Access" section.

### PVC permission errors (EACCES)

**Cause:** The PVC was created with wrong ownership (e.g., from a previous deployment with different UID settings).

**Fix:**

```bash
oc delete pvc openclaw-home-pvc -n <namespace>
oc rollout restart deployment/openclaw -n <namespace>
```

The PVC will be recreated on the next pod start.

---

## 8. Teardown

### Remove everything

```bash
./scripts/teardown.sh
```

**Expected output:**

```
ℹ️  Removing cluster-viewer ClusterRoleBinding...
✅ ClusterRoleBinding openclaw-cluster-viewer-alice-openclaw deleted
ℹ️  Removing OpenClaw OAuthClient...
✅ OAuthClient alice-openclaw deleted
ℹ️  Tearing down namespace alice-openclaw...
✅ All resources deleted from alice-openclaw
✅ Namespace alice-openclaw deleted
ℹ️  .env kept (use --delete-env to remove)
ℹ️  Cleaning up generated/ directory...
✅ Removed generated/ directory
```

### What gets cleaned up

- The namespace and all resources inside it (pods, services, ConfigMaps, secrets, PVCs, RBAC)
- The OAuthClient (cluster-scoped)
- The ClusterRoleBinding (cluster-scoped)
- The `generated/` directory

### What is preserved

- `.env` file (contains your API keys for re-deployment) — pass `--delete-env` to remove it too
- The ClusterRole `openclaw-cluster-viewer` (shared across instances, harmless to leave)

### Redeploy after teardown

```bash
./scripts/setup.sh
```

If your `.env` was preserved, the script detects it and offers to reuse the existing configuration
(same prefix, API keys, agent name).

---

## 9. Known Issues and Limitations

### Google AI Studio compatibility

Google AI Studio's OpenAI-compatible endpoint has several parameters it does not support. These are all
handled automatically by the config templates:

| Parameter | Gemini response | How we handle it |
|-----------|----------------|------------------|
| `thinking` | `Unknown name "thinking": Cannot find field` | `agents.defaults.thinkingDefault: "off"` |
| `store: false` | HTTP 400 | `models[].compat.supportsStore: false` |
| `stream_options` | Ignored silently | No action needed |

If you switch to Anthropic or another provider, these settings are harmless — they're only applied
to the Google AI Studio model definition.

### Container image limitations

The OpenClaw container image does not include `jq` or `oc`. The agent uses:

- `node -e` for JSON processing (Node.js is available since the gateway runs on Node.js)
- `curl` + ServiceAccount token for Kubernetes API queries (instead of `oc`)

These are configured in the `safeBins` allowlist and documented in the agent's `TOOLS.md`.

### Single-user application

OpenClaw is a single-user application. Each instance is one agent for one user. To serve multiple users,
deploy separate instances with different namespace prefixes:

```bash
# User 1
OPENCLAW_PREFIX=alice ./scripts/setup.sh

# User 2
OPENCLAW_PREFIX=bob ./scripts/setup.sh
```

### Session caching

After changing models or config, existing agent sessions may cache old parameters (model ID, thinking
settings, tool definitions). To clear:

```bash
oc rollout restart deployment/openclaw -n <namespace>
```

This restarts the pod, which re-initializes the config from the ConfigMap.
