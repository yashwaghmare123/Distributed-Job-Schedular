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
  useEffect(() => { Promise.all([apiClient.workers(), apiClient.heartbeats(id)]).then(([workers, history]) => { const match = workers.data.find((item) => item.id === id); if (!match) throw new Error("Worker not found"); setWorker(match); setHeartbeats(history.data as Heartbeat[]); }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load worker")); }, [id]);
  if (error) return <><PageHeader eyebrow="Operations / worker detail" title="Unavailable" /><Failure message={error} /></>;
  if (!worker) return <><PageHeader eyebrow="Operations / worker detail" title="Loading worker" /><Loading /></>;
  return <><PageHeader eyebrow="Operations / worker detail" title={worker.name} detail={worker.id}><Link className="button secondary" href="/workers">Back to workers</Link><StatusBadge status={worker.status} /></PageHeader><div className="grid content-grid"><section className="panel"><h3 className="panel-title">Worker capacity</h3><div className="feed-item"><strong>Organization</strong><span>{worker.organizationId}</span></div><div className="feed-item"><strong>Current jobs</strong><span>{worker.currentJobCount}</span></div><div className="feed-item"><strong>Concurrency</strong><span>{worker.concurrency}</span></div><div className="feed-item"><strong>Last heartbeat</strong><span>{worker.lastHeartbeatAt ? new Date(worker.lastHeartbeatAt).toLocaleString() : "Never"}</span></div></section><section className="panel"><h3 className="panel-title">Heartbeat history</h3>{heartbeats.length ? heartbeats.slice(0, 10).map((heartbeat) => <div className="feed-item" key={heartbeat.id}><strong>{heartbeat.status}</strong><span>{heartbeat.currentJobCount} jobs · {new Date(heartbeat.recordedAt).toLocaleString()}</span></div>) : <div className="empty">No heartbeat records found.</div>}</section></div></>;
}
