"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import type { Worker } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";

type Heartbeat = { id: string; status: string; currentJobCount: number; recordedAt: string };

export default function WorkerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [worker, setWorker] = useState<Worker | null>(null);
  const [heartbeats, setHeartbeats] = useState<Heartbeat[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [workersResult, history] = await Promise.all([
          apiClient.workers("?page=1&limit=100"),
          apiClient.heartbeats(id)
        ]);
        const match = workersResult.data.find((item) => item.id === id);
        if (!match) throw new Error("Worker not found");
        if (!active) return;
        setWorker(match);
        setHeartbeats(history.data as Heartbeat[]);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Unable to load worker");
      }
    };

    void load();
    const refresh = window.setInterval(() => { void load(); }, 2000);
    return () => { active = false; window.clearInterval(refresh); };
  }, [id]);

  if (error) return <><PageHeader eyebrow="Operations / worker detail" title="Unavailable" /><Failure message={error} /></>;
  if (!worker) return <><PageHeader eyebrow="Operations / worker detail" title="Loading worker" /><Loading /></>;

  const utilization = worker.concurrency > 0 ? Math.round((worker.currentJobCount / worker.concurrency) * 100) : 0;

  return (
    <>
      <PageHeader eyebrow="Operations / worker detail" title={worker.name} detail={worker.id}>
        <Link className="button secondary" href="/workers">Back to workers</Link>
        <StatusBadge status={worker.status} />
      </PageHeader>

      <div className="grid content-grid">
        <section className="panel">
          <h3 className="panel-title">Worker capacity</h3>
          <div className="feed-item"><strong>Worker</strong><span>{worker.name}</span></div>
          <div className="feed-item"><strong>Status</strong><span><StatusBadge status={worker.status} /></span></div>
          <div className="feed-item"><strong>Current jobs</strong><span>{worker.currentJobCount}</span></div>
          <div className="feed-item"><strong>Concurrency</strong><span>{worker.concurrency}</span></div>
          <div className="feed-item"><strong>Utilization</strong><span>{utilization}%</span></div>
          <div className="feed-item"><strong>Working on</strong><span>{worker.currentJobs?.length ? worker.currentJobs.map((job) => <span key={job.id} style={{ display: "block" }}><Link href={`/jobs/${job.id}`}>{job.jobType}</Link></span>) : "No active job"}</span></div>
          <div className="feed-item"><strong>Last executed job</strong><span>{worker.lastJob ? <Link href={`/jobs/${worker.lastJob.id}`}>{worker.lastJob.jobType}</Link> : "No jobs processed"}</span></div>
          <div className="feed-item"><strong>Last heartbeat</strong><span>{worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).toLocaleString() : "Never"}</span></div>
          <div className="feed-item"><strong>Organization</strong><span>{worker.organizationId}</span></div>
        </section>

        <section className="panel">
          <h3 className="panel-title">Heartbeat history</h3>
          {heartbeats.length ? (
            <div className="feed-list">
              {heartbeats.slice(0, 10).map((heartbeat) => (
                <div className="feed-item" key={heartbeat.id}>
                  <strong>{heartbeat.status}</strong>
                  <span>{heartbeat.currentJobCount} jobs · {new Date(heartbeat.recordedAt).toLocaleString()}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="empty">No heartbeat records found.</div>
          )}
        </section>
      </div>
    </>
  );
}

