import type { SchedulerEvent } from "./types";

type Listener = (event: SchedulerEvent) => void;
type StatusListener = (status: SocketStatus) => void;
export type SocketStatus = "DISCONNECTED" | "RECONNECTING" | "CONNECTED";
const listeners = new Set<Listener>();
const statusListeners = new Set<StatusListener>();
let socket: WebSocket | null = null;
let status: SocketStatus = "DISCONNECTED";
let reconnectTimer: number | null = null;
const queueIds = new Set<string>();
const jobIds = new Set<string>();
const eventHistory: SchedulerEvent[] = [];

export function getRecentSocketEvents() { return [...eventHistory]; }
export function clearSocketEvents() { eventHistory.length = 0; }

function setStatus(nextStatus: SocketStatus) {
  status = nextStatus;
  statusListeners.forEach((listener) => listener(status));
}

export function connectSocket() {
  if (typeof window === "undefined" || socket || status === "RECONNECTING") return;
  const url = process.env.NEXT_PUBLIC_WS_URL; const token = sessionStorage.getItem("scheduler.access");
  if (!url || !token) return;
  setStatus("RECONNECTING"); const currentSocket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`); socket = currentSocket;
  currentSocket.onopen = () => { if (socket !== currentSocket) return; setStatus("CONNECTED"); queueIds.forEach((queueId) => currentSocket.send(JSON.stringify({ type: "subscribe", queueId }))); jobIds.forEach((jobId) => currentSocket.send(JSON.stringify({ type: "subscribe", jobId }))); };
  currentSocket.onmessage = (message) => { if (socket !== currentSocket) return; try { const event = JSON.parse(message.data) as SchedulerEvent; if (!event.type || event.type === "ready" || event.type === "subscription.updated") return; eventHistory.unshift(event); eventHistory.splice(100); listeners.forEach((listener) => listener(event)); } catch { /* ignore malformed notifications */ } };
  currentSocket.onclose = () => { if (socket !== currentSocket) return; socket = null; setStatus("DISCONNECTED"); if (listeners.size && reconnectTimer === null) reconnectTimer = window.setTimeout(() => { reconnectTimer = null; connectSocket(); }, 1500); };
  currentSocket.onerror = () => currentSocket.close();
}
export function disconnectSocket() { if (reconnectTimer !== null) { window.clearTimeout(reconnectTimer); reconnectTimer = null; } socket?.close(); socket = null; setStatus("DISCONNECTED"); }
export function subscribeSocket(listener: Listener) { listeners.add(listener); connectSocket(); return () => { listeners.delete(listener); if (!listeners.size) disconnectSocket(); }; }
export function subscribeSocketStatus(listener: StatusListener) { statusListeners.add(listener); listener(status); return () => statusListeners.delete(listener); }
export function subscribeQueue(queueId: string) { queueIds.add(queueId); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", queueId })); }
export function subscribeJob(jobId: string) { jobIds.add(jobId); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "subscribe", jobId })); }
export function unsubscribeJob(jobId: string) { jobIds.delete(jobId); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "unsubscribe", jobId })); }
export function resetSocketSubscriptions() {
  if (socket?.readyState === WebSocket.OPEN) queueIds.forEach((queueId) => socket?.send(JSON.stringify({ type: "unsubscribe", queueId })));
  if (socket?.readyState === WebSocket.OPEN) jobIds.forEach((jobId) => socket?.send(JSON.stringify({ type: "unsubscribe", jobId })));
  queueIds.clear();
  jobIds.clear();
  clearSocketEvents();
}
export function isSocketConnected() { return status === "CONNECTED"; }
export function getSocketStatus() { return status; }
