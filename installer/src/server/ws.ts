import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";

interface DeploySession {
  ws: WebSocket;
  deployId: string;
}

const sessions = new Map<string, DeploySession>();

export function setupWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "subscribe" && msg.deployId) {
          sessions.set(msg.deployId, { ws, deployId: msg.deployId });
        }
      } catch {
        // ignore invalid messages
      }
    });

    ws.on("close", () => {
      for (const [id, session] of sessions) {
        if (session.ws === ws) {
          sessions.delete(id);
        }
      }
    });
  });

  return wss;
}

export function createLogCallback(deployId: string): (line: string) => void {
  return (line: string) => {
    const session = sessions.get(deployId);
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify({ type: "log", deployId, line }));
    }
  };
}

export function sendStatus(deployId: string, status: string): void {
  const session = sessions.get(deployId);
  if (session && session.ws.readyState === WebSocket.OPEN) {
    session.ws.send(JSON.stringify({ type: "status", deployId, status }));
  }
}
