"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect } from "react";
import DashboardPage from "@/app/(app)/dashboard/page";
import { Loading } from "@/components/Shell";
import { useSelectedProject } from "@/lib/projectContext";

export default function ProjectOverviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { projects, selectedProjectId, loading, setSelectedProjectId } = useSelectedProject();
  const project = projects.find((item) => item.id === id);

  useEffect(() => {
    if (loading) return;
    if (!project) {
      router.replace("/projects");
      return;
    }
    if (selectedProjectId !== id) {
      setSelectedProjectId(id);
    }
  }, [id, loading, project, router, selectedProjectId, setSelectedProjectId]);

  if (loading || !project || selectedProjectId !== id) {
    return <Loading />;
  }

  return <DashboardPage />;
}
