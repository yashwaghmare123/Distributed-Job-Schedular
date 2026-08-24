"use client";

import { FormEvent, useEffect, useState } from "react";
import { apiClient } from "@/lib/api";
import type { Project } from "@/lib/types";
import Link from "next/link";
import { Failure, Loading, PageHeader } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const load = () => {
    setLoading(true);
    return apiClient
      .projects(`?page=${page}&limit=25`)
      .then((result) => {
        setProjects(result.data);
        setTotalPages(result.pagination?.totalPages ?? null);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "Unable to load projects"),
      )
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    void load();
  }, [page]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await apiClient.createProject({ name });
      setName("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to create project");
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Operations / projects"
        title="Project registry"
        detail="Tenant-authorized project spaces."
      />
      <div className="grid content-grid">
        <section className="panel">
          <div className="panel-head">
            <h3 className="panel-title">Projects</h3>
          </div>
          {loading && !error ? (
            <Loading />
          ) : (
            <>
              {projects.map((project) => (
                <div className="feed-item" key={project.id}>
                  <strong>
                    <Link href={`/projects/${project.id}`}>{project.name}</Link>
                  </strong>
                  <span>{project.description || "No description"} · {project.id.slice(0, 8)}</span>
                </div>
              ))}
              {!projects.length && <div className="empty">No projects found.</div>}
              <Pagination page={page} totalPages={totalPages} loading={loading} onChange={setPage} />
            </>
          )}
          {error && <Failure message={error} />}
        </section>
        <section className="panel">
          <h3 className="panel-title">New project</h3>
          <form
            className="form-grid"
            onSubmit={submit}
            style={{ marginTop: 20 }}
          >
            <div className="field">
              <label htmlFor="project-name">Name</label>
              <input
                id="project-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
              />
            </div>
            <button className="button" type="submit">
              Create project
            </button>
          </form>
        </section>
      </div>
    </>
  );
}
