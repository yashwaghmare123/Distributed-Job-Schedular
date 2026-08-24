"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { apiClient } from "@/lib/api";
import type { Project, Queue } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";

export default function QueueDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [queue, setQueue] = useState<Queue | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { apiClient.projects().then(async ({ data }) => { const results = await Promise.all(data.map(async (item) => ({ project: item, queues: (await apiClient.queues(item.id)).data }))); const match = results.flatMap((item) => item.queues.map((value) => ({ project: item.project, queue: value }))).find((item) => item.queue.id === id); if (!match) throw new Error("Queue not found"); setProject(match.project); setQueue(match.queue); }).catch((err) => setError(err instanceof Error ? err.message : "Unable to load queue")); }, [id]);
  if (error) return <><PageHeader eyebrow="Operations / queue detail" title="Unavailable" /><Failure message={error} /></>;
  if (!queue || !project) return <><PageHeader eyebrow="Operations / queue detail" title="Loading queue" /><Loading /></>;
  return <><PageHeader eyebrow="Operations / queue detail" title={queue.name} detail={queue.id}><Link className="button secondary" href="/queues">Back to queues</Link><StatusBadge status={queue.isPaused ? "OFFLINE" : "ONLINE"} /></PageHeader><section className="panel"><h3 className="panel-title">Queue configuration</h3><div className="feed-item"><strong>Project</strong><span>{project.name} · {project.id}</span></div><div className="feed-item"><strong>Concurrency</strong><span>{queue.concurrencyLimit}</span></div><div className="feed-item"><strong>Default priority</strong><span>{queue.defaultPriority}</span></div><div className="feed-item"><strong>Retry policy</strong><span>{queue.retryPolicyId}</span></div><div className="feed-item"><strong>Updated</strong><span>{new Date(queue.updatedAt).toLocaleString()}</span></div></section></>;
}
