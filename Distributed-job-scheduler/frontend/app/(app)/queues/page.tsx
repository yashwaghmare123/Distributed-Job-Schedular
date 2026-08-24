"use client";

import { FormEvent, useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, apiClient } from "@/lib/api";
import type { Project, Queue, RetryPolicy } from "@/lib/types";
import { Failure, Loading, PageHeader, StatusBadge } from "@/components/Shell";
import { Pagination } from "@/components/Pagination";

function policyDescription(policy: RetryPolicy) {
	const attemptLabel = `${policy.maxAttempts} attempt${policy.maxAttempts === 1 ? "" : "s"}`;
	if (policy.strategy === "FIXED") return `${attemptLabel} with a fixed delay between retries.`;
	if (policy.strategy === "LINEAR") return `${attemptLabel} with a linearly increasing delay between retries.`;
	return `${attemptLabel} with an exponentially increasing delay between retries.`;
}

function validationMessage(field: string, value: string) {
	if (field === "projectId" && !value) return "Select a project.";
	if (field === "name" && (!value.trim() || value.length > 200)) return "Queue name must contain 1 to 200 characters.";
	if (field === "defaultPriority" && (!Number.isInteger(Number(value)) || !Number.isSafeInteger(Number(value)))) return "Priority must be a safe integer.";
	if (field === "concurrencyLimit" && (!Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 1000)) return "Concurrency must be an integer between 1 and 1000.";
	if (field === "retryPolicyId" && !value) return "Select a retry policy.";
	return null;
}

export default function QueuesPage() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [queues, setQueues] = useState<Queue[]>([]);
	const [retryPolicies, setRetryPolicies] = useState<RetryPolicy[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState("");
	const [page, setPage] = useState(1);

	const load = async () => {
		try {
			const projectResult = await apiClient.allProjects();
			setProjects(projectResult);
			const values = await Promise.all(projectResult.map((project) => apiClient.allQueues(project.id)));
			setQueues(values.flatMap((value) => value));
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Unable to load queues");
		}

		try {
			const policyResult = await apiClient.retryPolicies();
			setRetryPolicies(policyResult.data);
		} catch {
			setRetryPolicies([]);
		}
	};

	useEffect(() => { void load().finally(() => setLoading(false)); }, []);
	const pageItems = queues.slice((page - 1) * 25, page * 25);
	const totalPages = Math.max(1, Math.ceil(queues.length / 25));

	const submit = async (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		setError(null);
		setMessage("");
		const form = event.currentTarget;
		const data = new FormData(form);
		const fields = ["projectId", "name", "defaultPriority", "concurrencyLimit", "retryPolicyId"];
		const invalid = fields.map((field) => validationMessage(field, String(data.get(field) ?? ""))).find(Boolean);
		if (invalid) {
			setError(invalid);
			return;
		}
		try {
			await apiClient.createQueue(String(data.get("projectId")), {
				name: String(data.get("name")).trim(),
				description: String(data.get("description") || "").trim(),
				defaultPriority: Number(data.get("defaultPriority")),
				concurrencyLimit: Number(data.get("concurrencyLimit")),
				retryPolicyId: String(data.get("retryPolicyId")),
				isPaused: false
			});
			setMessage("Queue created");
			form.reset();
			await load();
		} catch (err) {
			if (err instanceof ApiError && err.details?.length) {
				setError(err.details.map((detail) => `${detail.path ? `${detail.path}: ` : ""}${detail.message}`).join("; "));
			} else {
				setError(err instanceof Error ? err.message : "Unable to create queue");
			}
		}
	};

	return <>
		<PageHeader eyebrow="Operations / queues" title="Queue topology" detail="Queue configuration and pause state." />
		{error && <Failure message={error} />}
		<div className="grid content-grid">
			{loading && !error ? <Loading /> : <section className="panel"><div className="table-wrap"><table><thead><tr><th>Name</th><th>State</th><th>Concurrency</th><th>Default priority</th><th>Project</th></tr></thead><tbody>{pageItems.map((queue) => <tr key={queue.id}><td><Link href={`/queues/${queue.id}`}>{queue.name}</Link></td><td><StatusBadge status={queue.isPaused ? "OFFLINE" : "ONLINE"} /></td><td>{queue.concurrencyLimit}</td><td>{queue.defaultPriority}</td><td className="mono">{queue.projectId.slice(0, 8)}</td></tr>)}</tbody></table>{queues.length === 0 && <div className="empty">No queues found.</div>}<Pagination page={page} totalPages={totalPages} loading={loading} onChange={setPage} /></div></section>}
			<section className="panel"><h3 className="panel-title">New queue</h3><form className="form-grid" onSubmit={submit} style={{ marginTop: 20 }}>
				{message && <div className="status-pill">{message}</div>}
				<div className="field"><label htmlFor="projectId">Project</label><select id="projectId" name="projectId" required><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></div>
				<div className="field"><label htmlFor="queue-name">Queue name</label><input id="queue-name" name="name" required maxLength={200} /></div>
				<div className="field"><label htmlFor="queue-description">Description</label><input id="queue-description" name="description" maxLength={1000} /></div>
				<div className="field"><label htmlFor="defaultPriority">Priority</label><input id="defaultPriority" name="defaultPriority" type="number" defaultValue="0" /></div>
				<div className="field"><label htmlFor="concurrencyLimit">Concurrency</label><input id="concurrencyLimit" name="concurrencyLimit" type="number" min="1" max="1000" defaultValue="5" required /></div>
				<div className="field"><label htmlFor="retryPolicyId">Retry policy</label><select id="retryPolicyId" name="retryPolicyId" required>
					<option value="">Select retry policy</option>
					{retryPolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name} ({policy.strategy}, {policy.maxAttempts} attempts)</option>)}
				</select>
				{retryPolicies.length === 0 && <><div className="error">No retry policies available.</div><span className="subtle">A retry policy must be configured by the backend before a queue can be created.</span></>}
				{retryPolicies.length > 0 && <span className="subtle">Controls how failed jobs are retried before they reach the Dead Letter Queue.</span>}
			</div>
				<button className="button" type="submit">Create queue</button>
			</form>{retryPolicies.length > 0 && <div className="subtle" style={{ marginTop: 16 }}>{retryPolicies.map((policy) => <div key={policy.id}>{policy.name}: {policyDescription(policy)}</div>)}</div>}</section>
		</div>
	</>;
}
