"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useSchedulerData } from "@/hooks/useScheduler";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { OverviewMetrics } from "@/components/OverviewMetrics";
import { useSelectedProject } from "@/lib/projectContext";

export default function DashboardPage() {
  const router = useRouter();
  const { selectedProject } = useSelectedProject();
  const [refreshSignal, setRefreshSignal] = useState(0);
  const { jobs, workers, events, loading, error, reload } = useSchedulerData(selectedProject?.id ?? null);

  useEffect(() => {
    if (!selectedProject) router.replace("/projects");
  }, [router, selectedProject]);

  if (loading) return <><PageHeader eyebrow={selectedProject ? `Operations / ${selectedProject.name}` : "Operations"} title={selectedProject ? `${selectedProject.name} overview` : "Dashboard"} detail="Monitor scheduler jobs, queues and system health." /><Loading /></>;

  return <>
    <PageHeader eyebrow={selectedProject ? `Operations / ${selectedProject.name}` : "Operations"} title={selectedProject ? `${selectedProject.name} overview` : "Dashboard"} detail="Monitor scheduler jobs, queues and system health."><button className="button secondary" type="button" onClick={() => { setRefreshSignal((value) => value + 1); void reload(); }}><RefreshCw size={14} /> Refresh</button></PageHeader>
    {error && <Failure message={error} />}
    <OverviewMetrics jobs={jobs} events={events.length} projectId={selectedProject?.id ?? null} refreshSignal={refreshSignal} />
  </>;
}
