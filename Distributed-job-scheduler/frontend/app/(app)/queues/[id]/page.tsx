"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import type { Queue, RetryPolicy } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { useSelectedProject } from "@/lib/projectContext";

function describeRetryPolicy(policy: RetryPolicy | null) {
  if (!policy) return "Not available";
  const maxAttempts = `${policy.maxAttempts} attempt${policy.maxAttempts === 1 ? "" : "s"}`;
  const strategy = policy.strategy ? `Strategy: ${policy.strategy}` : "Strategy: Not available";
  return `${policy.name} — ${maxAttempts} — ${strategy}`;
}

function formatDelay(delayMs: number | null | undefined) {
  return delayMs == null ? "Not available" : `${delayMs / 1000} seconds`;
}

export default function QueueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { selectedProject } = useSelectedProject();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [retryPolicies, setRetryPolicies] = useState<RetryPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [stats, setStats] = useState({ queued: 0, claimed: 0, running: 0, completed: 0, failed: 0, retry: 0, dlq: 0, queueDepth: 0 });

  const load = async () => {
    if (!selectedProject) {
      setQueue(null);
      setRetryPolicies([]);
      setStats({ queued: 0, claimed: 0, running: 0, completed: 0, failed: 0, retry: 0, dlq: 0, queueDepth: 0 });
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [queues, jobs, dlqEntries, policyResult] = await Promise.all([
        apiClient.allQueues(selectedProject.id),
        apiClient.allJobs(selectedProject.id),
        apiClient.allDlq(selectedProject.id),
        apiClient.retryPolicies().catch(() => ({ data: [] as RetryPolicy[] }))
      ]);
      const match = queues.find((item) => item.id === id) ?? null;
      if (!match) throw new Error("Queue not found.");

      const queueJobs = jobs.filter((job) => job.queueId === match.id);
      const queueDlq = dlqEntries.filter((entry) => entry.job?.queueId === match.id || entry.job?.queue?.id === match.id);
      const nextStats = {
        queued: queueJobs.filter((job) => job.status === "QUEUED").length,
        claimed: queueJobs.filter((job) => job.status === "CLAIMED").length,
        running: queueJobs.filter((job) => job.status === "RUNNING").length,
        completed: queueJobs.filter((job) => job.status === "COMPLETED").length,
        failed: queueJobs.filter((job) => job.status === "FAILED").length,
        retry: queueJobs.filter((job) => job.status === "RETRY").length,
        dlq: queueDlq.length,
        queueDepth: queueJobs.filter((job) => ["QUEUED", "RUNNING"].includes(job.status)).length
      };

      setQueue(match);
      setRetryPolicies(policyResult.data);
      setStats(nextStats);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load queue");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [id, selectedProject?.id]);

  const updatePauseState = async () => {
    if (!queue) return;
    setBusy(true);
    try {
      await apiClient.updateQueue(queue.id, { isPaused: !queue.isPaused });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update queue state");
    } finally {
      setBusy(false);
    }
  };

  const policy = queue?.retryPolicy ?? retryPolicies.find((value) => value.id === queue?.retryPolicyId) ?? null;

  if (error) {
    return <><PageHeader eyebrow="Operations / queue detail" title="Unavailable" /><Failure message={error} /></>;
  }

  if (loading || !queue || !selectedProject) {
    return <><PageHeader eyebrow="Operations / queue detail" title="Loading queue" /><Loading /></>;
  }

  const activeUsage = stats.claimed + stats.running;

  return (
    <>
      <PageHeader eyebrow="Operations / queue detail" title={queue.name} detail={queue.id}>
        <Link className="button secondary" href="/queues">Back to queues</Link>
        <button className="button secondary" type="button" onClick={updatePauseState} disabled={busy}>
          {busy ? (queue.isPaused ? "Resuming..." : "Pausing...") : queue.isPaused ? "Resume queue" : "Pause queue"}
        </button>
        <StatusBadge status={queue.isPaused ? "PAUSED" : "ACTIVE"} />
      </PageHeader>

      <section className="panel" style={{ marginBottom: 20 }}>
        <h3 className="panel-title">Queue configuration</h3>
        <div className="feed-item"><strong>Name</strong><span>{queue.name}</span></div>
        <div className="feed-item"><strong>Description</strong><span>{queue.description || "Not available"}</span></div>
        <div className="feed-item"><strong>Status</strong><span>{queue.isPaused ? "Paused" : "Active"}</span></div>
        <div className="feed-item"><strong>Priority</strong><span>{queue.defaultPriority}</span></div>
        <div className="feed-item"><strong>Concurrency</strong><span>{activeUsage} / {queue.concurrencyLimit} active</span></div>
        <div className="feed-item"><strong>Concurrency limit</strong><span>{queue.concurrencyLimit}</span></div>
        <div className="feed-item"><strong>Retry policy</strong><span>{describeRetryPolicy(policy)}</span></div>
        <div className="feed-item"><strong>Retry strategy</strong><span>{policy?.strategy ?? "Not available"}</span></div>
        <div className="feed-item"><strong>Max attempts</strong><span>{policy?.maxAttempts ?? "Not available"}</span></div>
        <div className="feed-item"><strong>Initial delay</strong><span>{formatDelay(policy?.initialDelayMs)}</span></div>
        <div className="feed-item"><strong>Max delay</strong><span>{policy?.maxDelayMs == null ? "Not available" : `${policy.maxDelayMs / 1000} seconds`}</span></div>
        <div className="feed-item"><strong>Project</strong><span>{selectedProject.name}</span></div>
        <div className="feed-item"><strong>Updated</strong><span>{new Date(queue.updatedAt).toLocaleString()}</span></div>
      </section>

      <section className="panel" style={{ marginBottom: 20 }}>
        <h3 className="panel-title">Real statistics</h3>
        <div className="grid stats metric-stats">
          {[
            ["Queued", stats.queued],
            ["Claimed", stats.claimed],
            ["Running", stats.running],
            ["Completed", stats.completed],
            ["Failed", stats.failed],
            ["Retry", stats.retry],
            ["DLQ", stats.dlq],
            ["Queue depth", stats.queueDepth]
          ].map(([label, value]) => (
            <div className="stat" key={String(label)}>
              <span className="stat-label">{String(label)}</span>
              <strong className="stat-value">{Number(value).toLocaleString()}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">Queue details</h3>
        <div className="feed-item"><strong>Default priority</strong><span>{queue.defaultPriority}</span></div>
        <div className="feed-item"><strong>Concurrency usage</strong><span>{activeUsage} active jobs</span></div>
        <div className="feed-item"><strong>Available slots</strong><span>{Math.max(queue.concurrencyLimit - activeUsage, 0)} free</span></div>
        <div className="feed-item"><strong>Pause / resume status</strong><span>{queue.isPaused ? "Paused" : "Running"}</span></div>
        <div className="feed-item"><strong>Retry configuration</strong><span>{describeRetryPolicy(policy)}</span></div>
      </section>
    </>
  );
}

