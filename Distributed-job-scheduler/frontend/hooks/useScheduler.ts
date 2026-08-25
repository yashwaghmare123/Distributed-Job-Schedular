"use client";

import { useEffect, useRef, useState } from "react";
import { apiClient } from "@/lib/api";
import type { SchedulerEvent } from "@/lib/types";
import { getRecentSocketEvents, resetSocketSubscriptions, subscribeQueue, subscribeSocket, subscribeSocketStatus, type SocketStatus } from "@/lib/socket";

export function useSchedulerData(projectId?: string | null) {
  const [jobs, setJobs] = useState<import("@/lib/types").Job[]>([]);
  const [workers, setWorkers] = useState<import("@/lib/types").Worker[]>([]);
  const [events, setEvents] = useState<SchedulerEvent[]>(getRecentSocketEvents());
  const [socketStatus, setSocketStatus] = useState<SocketStatus>("DISCONNECTED");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const queueIdsRef = useRef(new Set<string>());
  const activeProjectRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptRef = useRef(0);

  const load = async () => {
    if (!projectId) {
      setJobs([]);
      setWorkers([]);
      setEvents([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [allJobs, workerResponse, queues] = await Promise.all([apiClient.allJobs(projectId), apiClient.workers(), apiClient.allQueues(projectId)]);
      if (activeProjectRef.current !== projectId) return;
      const discoveredQueueIds = queues.map((queue) => queue.id);
      queueIdsRef.current = new Set(discoveredQueueIds);
      discoveredQueueIds.forEach(subscribeQueue);
      if (activeProjectRef.current !== projectId) return;
      setJobs(allJobs);
      setWorkers(workerResponse.data);
      setError(null);
    } catch (err) {
      if (activeProjectRef.current !== projectId) return;
      const rateLimited = err instanceof Error && "status" in err && err.status === 429;
      setError(rateLimited ? "Metrics temporarily rate limited. Retrying shortly." : err instanceof Error ? err.message : "Unable to load scheduler data");
      if (rateLimited && retryTimerRef.current === null) {
        const delay = Math.min(5000 * 2 ** retryAttemptRef.current, 60000);
        retryAttemptRef.current += 1;
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          void load();
        }, delay);
      }
    } finally {
      if (activeProjectRef.current === projectId) setLoading(false);
    }
  };

  useEffect(() => {
    activeProjectRef.current = projectId ?? null;
    resetSocketSubscriptions();
    setJobs([]);
    setWorkers([]);
    setEvents([]);
    void load();
    const scheduleRefresh = () => {
      if (refreshTimerRef.current !== null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void load();
      }, 60000);
    };

    const unsubscribe = subscribeSocket((event) => {
      if (!projectId || event.projectId !== projectId) return;
      setEvents((current) => [event, ...current.filter((item) => item.eventId !== event.eventId)].slice(0, 15));
      if (event.type === "worker.heartbeat" && event.workerId) {
        setWorkers((current) => current.map((worker) => worker.id === event.workerId ? { ...worker, status: event.payload.status === "ONLINE" ? "ONLINE" : worker.status, currentJobCount: event.payload.currentJobCount ?? worker.currentJobCount, lastHeartbeatAt: event.occurredAt } : worker));
        return;
      }
      if (event.workerId && (event.type === "worker.offline" || event.type === "worker.recovered")) {
        setWorkers((current) => current.map((worker) => worker.id === event.workerId ? { ...worker, status: event.payload.status === "OFFLINE" ? "OFFLINE" : event.payload.status === "ONLINE" ? "ONLINE" : worker.status, updatedAt: event.occurredAt } : worker));
        return;
      }
      if (event.jobId && event.payload.status && event.type !== "job.queued" && event.type !== "job.scheduled") {
        setJobs((current) => current.map((job) => job.id === event.jobId ? { ...job, status: event.payload.status as typeof job.status, attemptCount: event.payload.attemptCount ?? job.attemptCount, updatedAt: event.occurredAt } : job));
        return;
      }
      scheduleRefresh();
    });

    const unsubscribeStatus = subscribeSocketStatus((status) => {
      setSocketStatus(status);
      if (status === "CONNECTED") scheduleRefresh();
    });

    return () => {
      unsubscribe();
      unsubscribeStatus();
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      if (retryTimerRef.current !== null) window.clearTimeout(retryTimerRef.current);
    };
  }, [projectId]);

  useEffect(() => {
    if (!jobs.length) return;
    [...new Set(jobs.map((job) => job.queueId))].forEach(subscribeQueue);
  }, [jobs]);

  const reload = () => {
    if (retryTimerRef.current !== null) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    retryAttemptRef.current = 0;
    return load();
  };

  return { jobs, workers, events, socketStatus, loading, error, reload };
}
