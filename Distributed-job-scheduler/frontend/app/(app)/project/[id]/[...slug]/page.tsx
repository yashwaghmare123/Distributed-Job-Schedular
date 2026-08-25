"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import DashboardPage from "@/app/(app)/dashboard/page";
import JobsPage from "@/app/(app)/jobs/page";
import NewJobPage from "@/app/(app)/jobs/new/page";
import BatchJobsPage from "@/app/(app)/jobs/batch/page";
import QueuesPage from "@/app/(app)/queues/page";
import WorkersPage from "@/app/(app)/workers/page";
import ExecutionsPage from "@/app/(app)/executions/page";
import ScheduledPage from "@/app/(app)/scheduled/page";
import DlqPage from "@/app/(app)/dlq/page";
import MetricsPage from "@/app/(app)/metrics/page";
import HealthPage from "@/app/(app)/health/page";
import { Loading } from "@/components/Shell";
import { useSelectedProject } from "@/lib/projectContext";

const pages: Record<string, React.ComponentType> = {
  jobs: JobsPage,
  "jobs/new": NewJobPage,
  "jobs/batch": BatchJobsPage,
  queues: QueuesPage,
  workers: WorkersPage,
  executions: ExecutionsPage,
  scheduled: ScheduledPage,
  dlq: DlqPage,
  metrics: MetricsPage,
  health: HealthPage,
  overview: DashboardPage,
};

export default function ProjectControlPlanePage() {
  const { id, slug } = useParams<{ id: string; slug: string[] }>();
  const router = useRouter();
  const { projects, selectedProjectId, loading, setSelectedProjectId } = useSelectedProject();
  const project = projects.find((item) => item.id === id);
  const Page = pages[slug?.join("/") ?? "overview"];

  useEffect(() => {
    if (loading) return;
    if (!project) {
      router.replace("/projects");
      return;
    }
    if (selectedProjectId !== id) setSelectedProjectId(id);
  }, [id, loading, project, router, selectedProjectId, setSelectedProjectId]);

  if (loading || !project || selectedProjectId !== id || !Page) return <Loading />;
  return <Page />;
}
