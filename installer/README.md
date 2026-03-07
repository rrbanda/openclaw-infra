# OpenClaw Installer

> **WIP — This is a work in progress. The local (this machine) deployer works, cluster and SSH modes are not yet implemented.**

A web-based installer and fleet manager for OpenClaw. Deploy and manage OpenClaw instances from a browser — on your laptop, on a cluster, or across edge machines.

## Deployment Modes

| Mode | Status | What It Does |
|------|--------|-------------|
| **This Machine** | Working | Runs OpenClaw in podman/docker on localhost |
| **Kubernetes / OpenShift** | Planned | Deploys to a cluster via K8s API |
| **Remote Host** | Planned | Deploys via SSH (runs setup-edge.sh remotely) |
| **Edge Fleet** | Planned | Multi-host orchestration |

## Quick Start

```bash
cd installer
npm install
npm run dev
# Open http://localhost:3001
```

The UI opens in your browser. Pick "This Machine", fill in your agent name and API key, hit Deploy. The installer pulls the OpenClaw image, starts a container, and streams logs in real time.

## Architecture

```
┌─────────────────────────────────────────┐
│           Browser (React + Vite)        │
│  ┌────────────┬──────────┬───────────┐  │
│  │ DeployForm │ LogStream│ Instances │  │
│  └─────┬──────┴────┬─────┴─────┬─────┘  │
│        │ REST      │ WebSocket │ REST   │
└────────┼───────────┼──────────┼─────────┘
         ▼           ▼          ▼
┌─────────────────────────────────────────┐
│        Express + WebSocket Server       │
│  ┌──────────┐  ┌──────────────────────┐ │
│  │ Deployers│  │ Services             │ │
│  │  local   │  │  container (podman)  │ │
│  │  k8s     │  │  state (JSON)        │ │
│  │  ssh     │  │  git (clone+scan)    │ │
│  └──────────┘  └──────────────────────┘ │
└─────────────────────────────────────────┘
```

## API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/health` | GET | Runtime detection, version |
| `/api/deploy` | POST | Start a deployment (returns deployId, streams logs via WS) |
| `/api/instances` | GET | List all deployed instances with live status |
| `/api/instances/:id` | GET | Single instance status |
| `/api/instances/:id/stop` | POST | Stop an instance |
| `/api/instances/:id` | DELETE | Teardown and remove |
| `/api/agents/local` | GET | List agents from this repo |
| `/api/agents/browse?repo=...` | GET | List agents from a public git repo |
| `/ws` | WebSocket | Subscribe to deploy logs by deployId |

## Running in Production

Build and run the container:

```bash
cd installer
podman build -t openclaw-installer .
podman run -p 3000:3000 -v /run/podman/podman.sock:/run/podman/podman.sock openclaw-installer
```

Or deploy to a cluster as a self-service portal (needs a ServiceAccount with namespace creation permissions).

## Project Structure

```
installer/
├── src/
│   ├── server/
│   │   ├── index.ts              # Express + WS server, serves static frontend
│   │   ├── ws.ts                 # WebSocket log streaming
│   │   ├── routes/
│   │   │   ├── deploy.ts         # POST /api/deploy
│   │   │   ├── status.ts         # Instance management
│   │   │   └── agents.ts         # Agent browsing (local + git)
│   │   ├── deployers/
│   │   │   ├── types.ts          # Deployer interface
│   │   │   └── local.ts          # podman/docker deployer
│   │   └── services/
│   │       ├── container.ts      # Runtime detection and control
│   │       └── state.ts          # Instance persistence (~/.openclaw-installer/)
│   └── client/
│       ├── App.tsx               # Tabs: Deploy | Instances
│       ├── components/
│       │   ├── DeployForm.tsx     # Mode selector + config form
│       │   ├── LogStream.tsx      # Real-time deploy output
│       │   ├── InstanceList.tsx   # Manage running instances
│       │   └── AgentBrowser.tsx   # Browse/import agents from git
│       └── styles/theme.css      # Dark theme matching OpenClaw UI
├── Dockerfile                    # Container image
└── package.json
```

## Roadmap

- [ ] Local deployer (podman/docker on this machine)
- [ ] Instance management (stop, restart, teardown)
- [ ] Agent import from public git repos
- [ ] Kubernetes deployer (K8s API via ServiceAccount)
- [ ] SSH deployer (remote host via setup-edge.sh)
- [ ] Fleet deployer (multi-host orchestration)
- [ ] .env file upload/download
- [ ] Private git repo auth (PAT)
- [ ] In-cluster deployment (self-service portal on OpenShift)
