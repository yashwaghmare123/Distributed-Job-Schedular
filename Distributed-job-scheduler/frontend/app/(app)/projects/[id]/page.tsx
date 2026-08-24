"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { apiClient } from "@/lib/api";
import type { Project, Queue } from "@/lib/types";

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<Project | null>(null);
  const [queues, setQueues] = useState<Queue[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([apiClient.projects(), apiClient.queues(id)])
      .then(([projects, queueResult]) => {
        const match = projects.data.find((item) => item.id === id);
        if (!match) throw new Error("Project not found");
        setProject(match);
        setQueues(queueResult.data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load project"));
  }, [id]);

  if (error) return <><PageHeader eyebrow="Operations / project detail" title="Unavailable" /><Failure message={error} /></>;
  if (!project) return <><PageHeader eyebrow="Operations / project detail" title="Loading project" /><Loading /></>;

  return <>
    <PageHeader eyebrow="Operations / project detail" title={project.name} detail={project.id}>
      <Link className="button secondary" href="/projects">Back to projects</Link>
    </PageHeader>
    <div className="grid content-grid">
      <section className="panel"><h3 className="panel-title">Project metadata</h3><div className="feed-item"><strong>Description</strong><span>{project.description || "No description"}</span></div><div className="feed-item"><strong>Organization</strong><span>{project.organizationId}</span></div></section>
      <section className="panel"><h3 className="panel-title">Queues</h3>{queues.length ? queues.map((queue) => <div className="feed-item" key={queue.id}><strong><Link href={`/queues/${queue.id}`}>{queue.name}</Link></strong><span><StatusBadge status={queue.isPaused ? "OFFLINE" : "ONLINE"} /> · {queue.id}</span></div>) : <div className="empty">No queues found.</div>}</section>
    </div>
  </>;
}