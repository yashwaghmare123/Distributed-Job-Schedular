"use client";

import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import type { SchedulerEvent } from "@/lib/types";
import { getRecentSocketEvents, subscribeQueue, subscribeSocket, subscribeSocketStatus, type SocketStatus } from "@/lib/socket";

export function useSchedulerData() {
  const [jobs, setJobs] = useState<import("@/lib/types").Job[]>([]);
  const [workers, setWorkers] = useState<import("@/lib/types").Worker[]>([]);
  const [events, setEvents] = useState<SchedulerEvent[]>(getRecentSocketEvents());
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queueIdsRef = useRef(new Set<string>());
  const refreshTimerRef = useRef<number | null>(null);
  const load = async () => { try { const [jobs, workerResponse, projects] = await Promise.all([apiClient.allJobs(), apiClient.workers(), apiClient.allProjects()]); const queueResponses = await Promise.all(projects.map((project) => apiClient.allQueues(project.id))); const discoveredQueueIds = queueResponses.flatMap((queues) => queues.map((queue) => queue.id)); discoveredQueueIds.forEach((queueId) => queueIdsRef.current.add(queueId)); discoveredQueueIds.forEach(subscribeQueue); setJobs(jobs); setWorkers(workerResponse.data); setError(null); } catch (err) { setError(err instanceof Error ? err.message : "Unable to load scheduler data"); } finally { setLoading(false); } };
  useEffect(() => { void load(); const scheduleRefresh = () => { if (refreshTimerRef.current !== null) return; refreshTimerRef.current = window.setTimeout(() => { refreshTimerRef.current = null; void load(); }, 10000); }; const unsubscribe = subscribeSocket((event) => { setEvents((current) => [event, ...current.filter((item) => item.eventId !== event.eventId)].slice(0, 15)); if (event.type === "worker.heartbeat" && event.workerId) { setWorkers((current) => current.map((worker) => worker.id === event.workerId ? { ...worker, status: event.payload.status === "ONLINE" ? "ONLINE" : worker.status, currentJobCount: event.payload.currentJobCount ?? worker.currentJobCount, lastHeartbeatAt: event.occurredAt } : worker)); return; } if (event.workerId && (event.type === "worker.offline" || event.type === "worker.recovered")) { setWorkers((current) => current.map((worker) => worker.id === event.workerId ? { ...worker, status: event.payload.status === "OFFLINE" ? "OFFLINE" : event.payload.status === "ONLINE" ? "ONLINE" : worker.status, updatedAt: event.occurredAt } : worker)); return; } if (event.jobId && event.payload.status && event.type !== "job.queued" && event.type !== "job.scheduled") { setJobs((current) => current.map((job) => job.id === event.jobId ? { ...job, status: event.payload.status as typeof job.status, attemptCount: event.payload.attemptCount ?? job.attemptCount, updatedAt: event.occurredAt } : job)); return; } scheduleRefresh(); }); const unsubscribeStatus = subscribeSocketStatus((status) => { setSocketStatus(status); if (status === "CONNECTED") scheduleRefresh(); }); return () => { unsubscribe(); unsubscribeStatus(); if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current); }; }, []);
  useEffect(() => { [...new Set(jobs.map((job) => job.queueId))].forEach(subscribeQueue); }, [jobs]);
  return { jobs, workers, events, socketStatus, loading, error, reload: load };
}
