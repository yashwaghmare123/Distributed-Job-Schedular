"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { apiClient } from "@/lib/api";
import type { Project } from "@/lib/types";

type ProjectContextValue = {
  projects: Project[];
  selectedProjectId: string | null;
  selectedProject: Project | null;
  loading: boolean;
  setSelectedProjectId: (projectId: string | null) => void;
  refreshProjects: () => Promise<void>;
};

const ProjectContext = createContext<ProjectContextValue | undefined>(undefined);

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshProjects = async () => {
    setLoading(true);
    try {
      const result = await apiClient.allProjects();
      setProjects(result);
      setSelectedProjectId((current) => current && result.some((project) => project.id === current) ? current : null);
    } catch {
      setProjects([]);
      setSelectedProjectId(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (typeof window === "undefined") return;
    const storedProjectId = window.sessionStorage.getItem("scheduler.projectId");
    if (storedProjectId) {
      setSelectedProjectId(storedProjectId);
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (selectedProjectId) {
      window.sessionStorage.setItem("scheduler.projectId", selectedProjectId);
    } else {
      window.sessionStorage.removeItem("scheduler.projectId");
    }
  }, [selectedProjectId]);

  useEffect(() => {
    void refreshProjects();
  }, []);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const value = useMemo<ProjectContextValue>(
    () => ({
      projects,
      selectedProjectId,
      selectedProject,
      loading,
      setSelectedProjectId,
      refreshProjects,
    }),
    [projects, selectedProjectId, selectedProject, loading],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useSelectedProject() {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error("useSelectedProject must be used within ProjectProvider");
  }
  return context;
}
