"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ApiError, apiClient } from "@/lib/api";
import type { Queue, RetryPolicy } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { useSelectedProject } from "@/lib/projectContext";

function policyDescription(policy: RetryPolicy) {
  const attemptLabel = `${policy.maxAttempts} attempt${policy.maxAttempts === 1 ? "" : "s"}`;
  if (policy.strategy === "FIXED") return `${attemptLabel} with a fixed delay between retries.`;
  if (policy.strategy === "LINEAR") return `${attemptLabel} with a linearly increasing delay between retries.`;
  if (policy.strategy === "EXPONENTIAL") return `${attemptLabel} with an exponentially increasing delay between retries.`;
  return `${attemptLabel} using the ${policy.strategy || "configured"} retry strategy.`;
}

function queueStatusLabel(queue: Queue) {
  return queue.isPaused ? "Paused" : "Active";
}

function validationMessage(field: string, value: string) {
  if (field === "name" && (!value.trim() || value.length > 200)) return "Queue name must contain 1 to 200 characters.";
  if (field === "defaultPriority" && (!Number.isInteger(Number(value)) || !Number.isSafeInteger(Number(value)))) return "Priority must be a safe integer.";
  if (field === "concurrencyLimit" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 1000)) return "Concurrency must be an integer between 1 and 1000.";
  if (field === "retryPolicyId" && !value) return "Select a retry policy.";
  return null;
}

export default function QueuesPage() {
  const { selectedProject } = useSelectedProject();
  const [queues, setQueues] = useState<Queue[]>([]);
  const [retryPolicies, setRetryPolicies] = useState<RetryPolicy[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "paused">("all");
  const [sortBy, setSortBy] = useState<"priority" | "name" | "depth">("priority");
  const [createBusy, setCreateBusy] = useState(false);
  const [pauseBusyId, setPauseBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [createForm, setCreateForm] = useState({
    name: "",
    description: "",
    defaultPriority: "0",
    concurrencyLimit: "5",
    retryPolicyId: "",
  });
  const [editForm, setEditForm] = useState({
    description: "",
    defaultPriority: "0",
    concurrencyLimit: "5",
    retryPolicyId: "",
  });

  const policyLookup = useMemo(
    () => Object.fromEntries(retryPolicies.map((policy) => [policy.id, policy])) as Record<string, RetryPolicy>,
    [retryPolicies]
  );

  const load = async () => {
    if (!selectedProject) {
      setQueues([]);
      setRetryPolicies([]);
      return;
    }

    try {
      const [queueResult, policyResult] = await Promise.all([
        apiClient.allQueues(selectedProject.id),
        apiClient.retryPolicies().catch(() => ({ data: [] as RetryPolicy[] }))
      ]);
      setQueues(queueResult);
      setRetryPolicies(policyResult.data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load queues");
      setQueues([]);
      setRetryPolicies([]);
    }
  };

  useEffect(() => {
    setLoading(true);
    setQueues([]);
    setRetryPolicies([]);
    setMessage("");
    setSearch("");
    setStatusFilter("all");
    setCreateForm({ name: "", description: "", defaultPriority: "0", concurrencyLimit: "5", retryPolicyId: "" });
    setEditingId(null);
    if (!selectedProject) {
      setLoading(false);
      return;
    }
    void load().finally(() => setLoading(false));
  }, [selectedProject?.id]);

  const filteredQueues = useMemo(() => {
    const query = search.trim().toLowerCase();
    return [...queues]
      .filter((queue) => {
        const matchesQuery = !query || queue.name.toLowerCase().includes(query) || (queue.description ?? "").toLowerCase().includes(query);
        const matchesStatus = statusFilter === "all" || (statusFilter === "active" ? !queue.isPaused : queue.isPaused);
        return matchesQuery && matchesStatus;
      })
      .sort((left, right) => {
        if (sortBy === "name") return left.name.localeCompare(right.name);
        if (sortBy === "depth") return right.defaultPriority - left.defaultPriority;
        return right.defaultPriority - left.defaultPriority || left.name.localeCompare(right.name);
      });
  }, [queues, search, sortBy, statusFilter]);

  const currentRetryPolicy = retryPolicies.find((policy) => policy.id === createForm.retryPolicyId) ?? null;

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProject) {
      setError("Select a project to create a queue.");
      return;
    }

    setError(null);
    setMessage("");

    const invalid = [
      validationMessage("name", createForm.name),
      validationMessage("defaultPriority", createForm.defaultPriority),
      validationMessage("concurrencyLimit", createForm.concurrencyLimit),
      validationMessage("retryPolicyId", createForm.retryPolicyId),
    ].find(Boolean);

    if (invalid) {
      setError(String(invalid));
      return;
    }

    setCreateBusy(true);
    try {
      const queue = await apiClient.createQueue(selectedProject.id, {
        name: createForm.name.trim(),
        description: createForm.description.trim() || undefined,
        defaultPriority: Number(createForm.defaultPriority),
        concurrencyLimit: Number(createForm.concurrencyLimit),
        retryPolicyId: createForm.retryPolicyId,
        isPaused: false,
      });
      setMessage(`Queue "${queue.name}" created.`);
      setCreateForm({ name: "", description: "", defaultPriority: "0", concurrencyLimit: "5", retryPolicyId: "" });
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) {
        setError(err.details.map((detail) => `${detail.path ? `${detail.path}: ` : ""}${detail.message}`).join("; "));
      } else {
        setError(err instanceof Error ? err.message : "Unable to create queue");
      }
    } finally {
      setCreateBusy(false);
    }
  };

  const togglePause = async (queue: Queue) => {
    if (!window.confirm(queue.isPaused ? `Resume queue "${queue.name}"?` : `Pause queue "${queue.name}"?\n\nPausing this queue will affect processing according to the scheduler's queue behavior.`)) {
      return;
    }

    setPauseBusyId(queue.id);
    try {
      await apiClient.updateQueue(queue.id, { isPaused: !queue.isPaused });
      setMessage(queue.isPaused ? `Queue "${queue.name}" resumed.` : `Queue "${queue.name}" paused.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to update queue state");
    } finally {
      setPauseBusyId(null);
    }
  };

  const startEditing = (queue: Queue) => {
    setEditingId(queue.id);
    setEditForm({
      description: queue.description ?? "",
      defaultPriority: String(queue.defaultPriority),
      concurrencyLimit: String(queue.concurrencyLimit),
      retryPolicyId: queue.retryPolicyId,
    });
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editingId) return;

    const invalid = [
      validationMessage("defaultPriority", editForm.defaultPriority),
      validationMessage("concurrencyLimit", editForm.concurrencyLimit),
      validationMessage("retryPolicyId", editForm.retryPolicyId),
    ].find(Boolean);

    if (invalid) {
      setError(String(invalid));
      return;
    }

    try {
      await apiClient.updateQueue(editingId, {
        description: editForm.description.trim() || null,
        defaultPriority: Number(editForm.defaultPriority),
        concurrencyLimit: Number(editForm.concurrencyLimit),
        retryPolicyId: editForm.retryPolicyId,
      });
      setEditingId(null);
      setMessage("Queue updated.");
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.details?.length) {
        setError(err.details.map((detail) => `${detail.path ? `${detail.path}: ` : ""}${detail.message}`).join("; "));
      } else {
        setError(err instanceof Error ? err.message : "Unable to update queue");
      }
    }
  };

  const emptyState = !loading && filteredQueues.length === 0;

  return (
    <>
      <PageHeader eyebrow="Operations / queues" title="Queue management" detail={selectedProject ? `Project-scoped queue configuration for ${selectedProject.name}.` : "Select a project to manage queues."} />
      {error && <Failure message={error} />}
      {message && <div className="status-pill" style={{ marginBottom: 16 }}>{message}</div>}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <h3 className="panel-title" style={{ margin: 0 }}>Create queue</h3>
          <span className="subtle">Project: {selectedProject ? selectedProject.name : "None"}</span>
        </div>
        <form onSubmit={submitCreate} className="form-grid" style={{ marginTop: 20 }}>
          <div className="field">
            <label htmlFor="queue-name">Queue Name</label>
            <input id="queue-name" value={createForm.name} onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))} maxLength={200} required />
          </div>
          <div className="field">
            <label htmlFor="queue-description">Description</label>
            <input id="queue-description" value={createForm.description} onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))} maxLength={1000} />
          </div>
          <div className="field">
            <label htmlFor="queue-priority">Priority</label>
            <input id="queue-priority" type="number" value={createForm.defaultPriority} onChange={(event) => setCreateForm((current) => ({ ...current, defaultPriority: event.target.value }))} />
          </div>
          <div className="field">
            <label htmlFor="queue-concurrency">Concurrency Limit</label>
            <input id="queue-concurrency" type="number" min={1} max={1000} value={createForm.concurrencyLimit} onChange={(event) => setCreateForm((current) => ({ ...current, concurrencyLimit: event.target.value }))} required />
          </div>
          <div className="field">
            <label htmlFor="queue-policy">Retry Policy</label>
            <select id="queue-policy" value={createForm.retryPolicyId} onChange={(event) => setCreateForm((current) => ({ ...current, retryPolicyId: event.target.value }))} required disabled={retryPolicies.length === 0}>
              <option value="">Select retry policy</option>
              {retryPolicies.map((policy) => (
                <option key={policy.id} value={policy.id}>{policy.name} ({policy.strategy})</option>
              ))}
            </select>
          </div>
          <div style={{ gridColumn: "1 / -1" }}>
            {retryPolicies.length === 0 ? (
              <div className="error">No retry policies available.</div>
            ) : currentRetryPolicy ? (
              <div className="subtle">
                <strong>{currentRetryPolicy.name}</strong>
                <div>{policyDescription(currentRetryPolicy)}</div>
                <div>Strategy: {currentRetryPolicy.strategy}</div>
                {currentRetryPolicy.initialDelayMs !== undefined && currentRetryPolicy.initialDelayMs !== null ? <div>Initial delay: {currentRetryPolicy.initialDelayMs / 1000} seconds</div> : <div>Initial delay: Not available</div>}
                {currentRetryPolicy.maxDelayMs !== undefined && currentRetryPolicy.maxDelayMs !== null ? <div>Backoff maximum: {currentRetryPolicy.maxDelayMs / 1000} seconds</div> : <div>Backoff maximum: Not available</div>}
              </div>
            ) : (
              <div className="subtle">Select a retry policy to show the backend policy details.</div>
            )}
          </div>
          <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 12 }}>
            <button type="button" className="button secondary" onClick={() => setCreateForm({ name: "", description: "", defaultPriority: "0", concurrencyLimit: "5", retryPolicyId: "" })}>Cancel</button>
            <button type="submit" className="button" disabled={createBusy || !selectedProject || retryPolicies.length === 0}>
              {createBusy ? "Creating…" : "Create Queue"}
            </button>
          </div>
        </form>
      </div>

      <section className="panel">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
          <div>
            <h3 className="panel-title" style={{ margin: 0 }}>Queue list</h3>
          </div>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
            <input aria-label="Search queue" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search queue" />
            <select aria-label="Filter queue status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | "active" | "paused")}>
              <option value="all">All statuses</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
            </select>
            <select aria-label="Sort queues" value={sortBy} onChange={(event) => setSortBy(event.target.value as "priority" | "name" | "depth") }>
              <option value="priority">Sort by priority</option>
              <option value="name">Sort by name</option>
              <option value="depth">Sort by depth</option>
            </select>
          </div>
        </div>

        {loading ? (
          <Loading />
        ) : emptyState ? (
          <div className="empty">No queues match the current project and filters.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Queue</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Concurrency</th>
                  <th>Retry policy</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredQueues.map((queue) => {
                  const policy = policyLookup[queue.retryPolicyId];
                  return (
                    <tr key={queue.id}>
                      <td>
                        <div style={{ display: "grid" }}>
                          <Link href={`/queues/${queue.id}`}><strong>{queue.name}</strong></Link>
                          {queue.description ? <span className="subtle">{queue.description}</span> : <span className="subtle">No description</span>}
                        </div>
                      </td>
                      <td><StatusBadge status={queue.isPaused ? "PAUSED" : "ACTIVE"} /></td>
                      <td>{queue.defaultPriority}</td>
                      <td>{queue.concurrencyLimit}</td>
                      <td>{policy ? policy.name : queue.retryPolicyId}</td>
                      <td>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <Link className="button secondary" href={`/queues/${queue.id}`}>Open</Link>
                          <button type="button" className="button secondary" onClick={() => togglePause(queue)} disabled={pauseBusyId === queue.id}>
                            {pauseBusyId === queue.id ? "Working…" : queue.isPaused ? "Resume" : "Pause"}
                          </button>
                          <button type="button" className="button secondary" onClick={() => startEditing(queue)}>Edit</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editingId && (
        <section className="panel" style={{ marginTop: 20 }}>
          <h3 className="panel-title">Edit queue</h3>
          <form onSubmit={submitEdit} className="form-grid" style={{ marginTop: 20 }}>
            <div className="field">
              <label htmlFor="edit-description">Description</label>
              <input id="edit-description" value={editForm.description} onChange={(event) => setEditForm((current) => ({ ...current, description: event.target.value }))} maxLength={1000} />
            </div>
            <div className="field">
              <label htmlFor="edit-priority">Priority</label>
              <input id="edit-priority" type="number" value={editForm.defaultPriority} onChange={(event) => setEditForm((current) => ({ ...current, defaultPriority: event.target.value }))} />
            </div>
            <div className="field">
              <label htmlFor="edit-concurrency">Concurrency Limit</label>
              <input id="edit-concurrency" type="number" min={1} max={1000} value={editForm.concurrencyLimit} onChange={(event) => setEditForm((current) => ({ ...current, concurrencyLimit: event.target.value }))} required />
            </div>
            <div className="field">
              <label htmlFor="edit-policy">Retry Policy</label>
              <select id="edit-policy" value={editForm.retryPolicyId} onChange={(event) => setEditForm((current) => ({ ...current, retryPolicyId: event.target.value }))} required disabled={retryPolicies.length === 0}>
                <option value="">Select retry policy</option>
                {retryPolicies.map((policy) => (
                  <option key={policy.id} value={policy.id}>{policy.name} ({policy.strategy})</option>
                ))}
              </select>
            </div>
            <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "flex-end", gap: 12 }}>
              <button type="button" className="button secondary" onClick={() => setEditingId(null)}>Cancel</button>
              <button type="submit" className="button">Save changes</button>
            </div>
          </form>
        </section>
      )}
    </>
  );
}
