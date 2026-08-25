import type { IncomingMessage, Server as HttpServer } from "node:http";
import { URL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { prisma } from "../lib/prisma.js";
import { verifyJwt } from "../api/lib/auth.js";
import { eventBus } from "./eventBus.js";
import type { SchedulerEvent } from "./eventTypes.js";

type Client = { socket: WebSocket; organizationIds: Set<string>; queues: Set<string>; jobs: Set<string> };

type ClientMessage = { type: "subscribe" | "unsubscribe"; queueId?: string; jobId?: string };

let websocketConfigured = false;
let websocketAttached = false;

export function getWebSocketHealth(): "ready" | "unavailable" | "not_configured" {
  if (!websocketConfigured) return "not_configured";
  return websocketAttached ? "ready" : "unavailable";
}

export class WebSocketHub {
  private readonly server: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly unsubscribeEvents: () => void;

  constructor() {
    this.server = new WebSocketServer({ noServer: true });
    this.unsubscribeEvents = eventBus.subscribe((event) => this.broadcast(event));
    this.server.on("connection", (socket, request) => void this.accept(socket, request));
    websocketConfigured = true;
  }

  attach(server: HttpServer): void {
    websocketAttached = true;
    server.on("upgrade", (request, socket, head) => {
      if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") {
        socket.destroy();
        return;
      }
      this.server.handleUpgrade(request, socket, head, (client) => this.server.emit("connection", client, request));
    });
  }

  close(): void {
    websocketAttached = false;
    this.unsubscribeEvents();
    for (const client of this.clients) client.socket.close();
    this.clients.clear();
    this.server.close();
  }

  private async accept(socket: WebSocket, request: IncomingMessage): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const rawToken = url.searchParams.get("token");
    if (!rawToken) return this.reject(socket, "Authentication required.");

    let token;
    try {
      token = verifyJwt(rawToken);
    } catch {
      return this.reject(socket, "Invalid or expired access token.");
    }
    if (token.type !== "access") return this.reject(socket, "An access token is required.");

    const client: Client = { socket, organizationIds: new Set(token.orgIds), queues: new Set(), jobs: new Set() };
    this.clients.add(client);
    socket.on("message", (message) => void this.handleMessage(client, message.toString()));
    socket.on("close", () => this.clients.delete(client));
    socket.on("error", () => this.clients.delete(client));
    socket.send(JSON.stringify({ type: "ready" }));
  }

  private async handleMessage(client: Client, raw: string): Promise<void> {
    let message: ClientMessage;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || !("type" in parsed) || !["subscribe", "unsubscribe"].includes(String(parsed.type))) throw new Error();
      message = parsed as ClientMessage;
    } catch {
      client.socket.send(JSON.stringify({ type: "error", code: "VALIDATION_ERROR", message: "Invalid WebSocket message." }));
      return;
    }

    if (message.queueId) {
      const queue = await prisma.queue.findUnique({ where: { id: message.queueId }, select: { id: true, project: { select: { organizationId: true } } } });
      if (!queue || !client.organizationIds.has(queue.project.organizationId)) {
        client.socket.send(JSON.stringify({ type: "error", code: "FORBIDDEN", message: "You do not have access to this queue." }));
        return;
      }
      (message.type === "subscribe" ? client.queues.add(queue.id) : client.queues.delete(queue.id));
    }
    if (message.jobId) {
      const job = await prisma.job.findUnique({ where: { id: message.jobId }, select: { id: true, queueId: true, queue: { select: { project: { select: { organizationId: true } } } } } });
      if (!job || !client.organizationIds.has(job.queue.project.organizationId)) {
        client.socket.send(JSON.stringify({ type: "error", code: "FORBIDDEN", message: "You do not have access to this job." }));
        return;
      }
      (message.type === "subscribe" ? client.jobs.add(job.id) : client.jobs.delete(job.id));
    }
    client.socket.send(JSON.stringify({ type: "subscription.updated", queues: [...client.queues], jobs: [...client.jobs] }));
  }

  private broadcast(event: SchedulerEvent): void {
    for (const client of this.clients) {
      const authorized = client.organizationIds.has(event.organizationId) &&
        ((!event.queueId && !event.jobId) || (event.jobId && client.jobs.has(event.jobId)) || (event.queueId && client.queues.has(event.queueId)));
      if (authorized && client.socket.readyState === 1) client.socket.send(JSON.stringify(event));
    }
  }

  private reject(socket: WebSocket, message: string): void {
    socket.close(1008, message);
  }
}
