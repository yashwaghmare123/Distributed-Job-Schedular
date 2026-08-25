"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { Clock3, Grid2X2, List, MoreVertical, Plus, Search, SlidersHorizontal, Trash2, Users, Workflow } from "lucide-react";
import { apiClient } from "@/lib/api";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";
import { useSelectedProject } from "@/lib/projectContext";

type ProjectMetrics = { queues: number; jobs: number; workers: number };

export default function ProjectsPage() {
  const { projects, setSelectedProjectId, refreshProjects } = useSelectedProject();
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"updated" | "name">("updated");
  const [metrics, setMetrics] = useState<Record<string, ProjectMetrics>>({});
  const openProject = (projectId: string) => {
    setSelectedProjectId(projectId);
    window.location.href = `/project/${projectId}/overview`;
  };

  const load = () => {
    setLoading(true);
    return apiClient.projects(`?page=${page}&limit=25`)
      .then((result) => setTotalPages(result.pagination?.totalPages ?? null))
      .catch((err) => setError(err instanceof Error ? err.message : "Unable to load projects"))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setSelectedProjectId(null);
    void load();
  }, [page]);

  useEffect(() => {
    if (!projects.length) return;
    void Promise.all(projects.map(async (project) => {
      const [queues, jobs] = await Promise.all([apiClient.allQueues(project.id), apiClient.allJobs(project.id)]);
      return [project.id, { queues: queues.length, jobs: jobs.length, workers: 0 }] as const;
    })).then((results) => setMetrics(Object.fromEntries(results))).catch(() => undefined);
  }, [projects]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (editingId) await apiClient.updateProject(editingId, { name, description: description.trim() || null });
      else await apiClient.createProject({ name, description: description.trim() || undefined });
      setName("");
      setDescription("");
      setEditingId(null);
      setModalOpen(false);
      await refreshProjects();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to save project");
    }
  };

  const deleteProject = async () => {
    if (!editingId) return;
    const project = projects.find((item) => item.id === editingId);
    if (!project || !window.confirm(`Delete project "${project.name}"? This cannot be undone.`)) return;

    setDeletingId(editingId);
    setError(null);
    try {
      await apiClient.deleteProject(editingId);
      setModalOpen(false);
      setEditingId(null);
      setSelectedProjectId(null);
      await refreshProjects();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to delete project");
    } finally {
      setDeletingId(null);
    }
  };

  const visibleProjects = useMemo(() => projects
    .filter((project) => `${project.name} ${project.description ?? ""}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : b.updatedAt.localeCompare(a.updatedAt)), [projects, search, sort]);

  const startCreate = () => {
    setEditingId(null);
    setName("");
    setDescription("");
    setModalOpen(true);
  };

  return (
    <div className="projects-page">
      <PageHeader eyebrow="Operations / projects" title="My Projects" detail="Create, manage and monitor your scheduler projects.">
        <button className="button" type="button" onClick={startCreate}><Plus size={15} /> Create Project</button>
      </PageHeader>

      <div className="project-toolbar">
        <label className="project-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects..." aria-label="Search projects" /></label>
        <div className="project-toolbar-actions">
          <label className="sort-control"><span>Sort by:</span><select value={sort} onChange={(event) => setSort(event.target.value as "updated" | "name")}><option value="updated">Last updated</option><option value="name">Name</option></select><SlidersHorizontal size={14} /></label>
          <button className="view-toggle active" type="button" aria-label="Grid view"><Grid2X2 size={16} /></button>
          <button className="view-toggle" type="button" aria-label="List view"><List size={16} /></button>
        </div>
      </div>

      {error && <Failure message={error} />}
      {loading && !error ? <Loading /> : <>
        <div className="projects-grid">
          {visibleProjects.map((project, index) => {
            const projectMetrics = metrics[project.id] ?? { queues: 0, jobs: 0, workers: 0 };
            const daysAgo = Math.round((new Date(project.updatedAt).getTime() - Date.now()) / 86400000);
            return <article className="project-tile" key={project.id} style={{ animationDelay: `${index * 60}ms` }}>
              <div className={`project-avatar avatar-${index % 5}`} aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</div>
              <div className="project-tile-copy"><h3>{project.name}</h3><p>{project.description || "No description"}</p><span className="mono">{project.id.slice(0, 8)}</span></div>
              <div className="project-metrics"><span><Workflow size={14} /><strong>{projectMetrics.queues}</strong><small>Queues</small></span><span><List size={14} /><strong>{projectMetrics.jobs > 999 ? `${(projectMetrics.jobs / 1000).toFixed(1)}K` : projectMetrics.jobs}</strong><small>Jobs</small></span><span><Users size={14} /><strong>{projectMetrics.workers}</strong><small>Workers</small></span></div>
              <div className="project-updated"><Clock3 size={14} /> Updated {new Intl.RelativeTimeFormat("en", { numeric: "auto" }).format(daysAgo, "day")}</div>
              <div className="project-tile-actions"><button className="button project-open" type="button" onClick={() => openProject(project.id)}>Open Project <span aria-hidden="true">›</span></button><button className="icon-button" type="button" aria-label={`Manage ${project.name}`} onClick={() => { setEditingId(project.id); setName(project.name); setDescription(project.description ?? ""); setModalOpen(true); }}><MoreVertical size={17} /></button></div>
            </article>;
          })}
        </div>
        {!visibleProjects.length && <div className="empty">No projects found.</div>}
        <div className="projects-footer"><span>Showing 1 to {visibleProjects.length} of {projects.length} projects</span><Pagination page={page} totalPages={totalPages} loading={loading} onChange={setPage} /></div>
      </>}

      {modalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target && !deletingId) setModalOpen(false); }}><section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-modal-title"><button className="modal-close" type="button" aria-label="Close" onClick={() => setModalOpen(false)} disabled={Boolean(deletingId)}>×</button><h2 id="project-modal-title">{editingId ? "Edit Project" : "Create Project"}</h2><form className="form-grid" onSubmit={submit}><div className="field"><label htmlFor="project-name">Project Name</label><input id="project-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Enter project name" autoFocus required disabled={Boolean(deletingId)} /></div><div className="field"><label htmlFor="project-description">Description <span>(optional)</span></label><textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={4} placeholder="Enter project description" disabled={Boolean(deletingId)} /></div><div className="modal-actions">{editingId && <button className="button danger" type="button" onClick={() => void deleteProject()} disabled={Boolean(deletingId)}><Trash2 size={14} />{deletingId ? "Deleting..." : "Delete Project"}</button>}<button className="button secondary" type="button" onClick={() => setModalOpen(false)} disabled={Boolean(deletingId)}>Cancel</button><button className="button" type="submit" disabled={Boolean(deletingId)}>{editingId ? "Save Changes" : "Create Project"}</button></div></form></section></div>}
    </div>
  );
}
