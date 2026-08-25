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

  useEffect(() => {
    if (!selectedProject) {
      setQueue(null);
      setRetryPolicies([]);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setError(null);

    Promise.all([
      apiClient.allQueues(selectedProject.id),
      apiClient.retryPolicies().catch(() => ({ data: [] as RetryPolicy[] }))
    ])
      .then(([queues, policyResult]) => {
        if (!active) return;
        const match = queues.find((item) => item.id === id) ?? null;
        if (!match) {
          throw new Error("Queue not found.");
        }
        setQueue(match);
        setRetryPolicies(policyResult.data);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Unable to load queue");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [id, selectedProject?.id]);

  const policy = queue?.retryPolicy ?? retryPolicies.find((value) => value.id === queue?.retryPolicyId) ?? null;

  if (error) {
    return (
      <>
        <PageHeader eyebrow="Operations / queue detail" title="Unavailable" />
        <Failure message={error} />
      </>
    );
  }

  if (loading || !queue || !selectedProject) {
    return (
      <>
        <PageHeader eyebrow="Operations / queue detail" title="Loading queue" />
        <Loading />
      </>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Operations / queue detail" title={queue.name} detail={queue.id}>
        <Link className="button secondary" href="/queues">Back to queues</Link>
        <StatusBadge status={queue.isPaused ? "PAUSED" : "ACTIVE"} />
      </PageHeader>

      <section className="panel" style={{ marginBottom: 20 }}>
        <h3 className="panel-title">Queue configuration</h3>
        <div className="feed-item"><strong>Name</strong><span>{queue.name}</span></div>
        <div className="feed-item"><strong>Description</strong><span>{queue.description || "Not available"}</span></div>
        <div className="feed-item"><strong>Status</strong><span>{queue.isPaused ? "Paused" : "Active"}</span></div>
        <div className="feed-item"><strong>Priority</strong><span>{queue.defaultPriority}</span></div>
        <div className="feed-item"><strong>Concurrency Limit</strong><span>{queue.concurrencyLimit}</span></div>
        <div className="feed-item"><strong>Retry Policy</strong><span>{describeRetryPolicy(policy)}</span></div>
        <div className="feed-item"><strong>Strategy</strong><span>{policy?.strategy ?? "Not available"}</span></div>
        <div className="feed-item"><strong>Maximum Attempts</strong><span>{policy?.maxAttempts ?? "Not available"}</span></div>
        <div className="feed-item"><strong>Initial Delay</strong><span>{formatDelay(policy?.initialDelayMs)}</span></div>
        <div className="feed-item"><strong>Project</strong><span>{selectedProject.name}</span></div>
        <div className="feed-item"><strong>Updated</strong><span>{new Date(queue.updatedAt).toLocaleString()}</span></div>
      </section>

      <section className="panel" style={{ marginBottom: 20 }}>
        <h3 className="panel-title">Statistics</h3>
        <div className="grid stats metric-stats">
          {[
            ["Queued", "Not available"],
            ["Claimed", "Not available"],
            ["Running", "Not available"],
            ["Completed", "Not available"],
            ["Failed", "Not available"],
            ["Retry", "Not available"],
            ["DLQ", "Not available"],
            ["Queue Depth", "Not available"]
          ].map(([label, value]) => (
            <div className="stat" key={label}>
              <span className="stat-label">{label}</span>
              <strong className="stat-value">{value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <h3 className="panel-title">Recent jobs</h3>
        <div className="empty">Recent jobs are not exposed by the backend for this queue.</div>
      </section>
    </>
  );
}
