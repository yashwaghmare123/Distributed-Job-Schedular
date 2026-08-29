import type {
  DlqEntry,
  Execution,
  ExecutionRow,
  Job,
  JobBatch,
  Project,
  Queue,
  QueueDepthSnapshot,
  RetryPolicy,
  ScheduledJob,
  Worker,
  WorkerUtilization,
} from "./types";

const base = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!base) throw new Error("NEXT_PUBLIC_API_BASE_URL is required");

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: Array<{ path?: string; message: string }>
  ) {
    super(message);
  }
}

const inFlightRequests = new Map<string, Promise<unknown>>();

const ACCESS_TOKEN_KEY = "scheduler.access";

export function setAccessToken(token: string | null) {
  if (typeof window === "undefined") return;

  if (token) {
    window.sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
  } else {
    window.sessionStorage.removeItem(ACCESS_TOKEN_KEY);
  }
}

export function getAccessToken() {
  if (typeof window === "undefined") return null;

  return window.sessionStorage.getItem(ACCESS_TOKEN_KEY);
}

export async function apiText(path: string): Promise<string> {
  const response = await fetch(`${base}${path}`, {
    credentials: "include",
  });

  const body = await response.text();

  if (!response.ok) {
    throw new ApiError(response.status, body || "Request failed");
  }

  return body;
}

function scopedQuery(query: string, projectId?: string | null) {
  if (!projectId) return query;

  const params = new URLSearchParams(
    query.startsWith("?") ? query.slice(1) : query
  );

  params.set("projectId", projectId);

  return `?${params.toString()}`;
}

async function request<T>(
  path: string,
  options: RequestInit,
  token: string | null
): Promise<{ response: Response; body: T }> {
  const headers = new Headers(options.headers);

  headers.set("Content-Type", "application/json");

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(`${base}${path}`, {
    ...options,
    credentials: "include",
    headers,
  });

  const body = (await response.json().catch(() => ({}))) as T;

  return { response, body };
}

async function requestApi<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  let token = getAccessToken();

  let { response, body } = await request<T>(path, options, token);

  if (
    response.status === 401 &&
    path !== "/auth/login" &&
    path !== "/auth/register" &&
    path !== "/auth/refresh" &&
    path !== "/auth/session"
  ) {
    const refreshResponse = await request<{
      accessToken: string;
      refreshToken: string;
    }>("/auth/refresh", { method: "POST" }, null);

    if (refreshResponse.response.ok) {
      const newToken = refreshResponse.body.accessToken;

      setAccessToken(newToken);

      token = newToken;

      ({ response, body } = await request<T>(path, options, token));
    } else {
      setAccessToken(null);
    }
  }

  const errorMessage =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "message" in body.error &&
    typeof body.error.message === "string"
      ? body.error.message
      : "Request failed";

  const errorDetails =
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "object" &&
    body.error !== null &&
    "details" in body.error &&
    Array.isArray(body.error.details)
      ? (body.error.details as Array<{
          path?: string;
          message: string;
        }>)
      : undefined;

  if (!response.ok) {
    throw new ApiError(response.status, errorMessage, errorDetails);
  }

  return body as T;
}

export function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const key = `${options.method ?? "GET"}:${path}:${
    typeof options.body === "string" ? options.body : ""
  }`;

  const existing = inFlightRequests.get(key) as Promise<T> | undefined;

  if (existing) return existing;

  const requestPromise = requestApi<T>(path, options).finally(() =>
    inFlightRequests.delete(key)
  );

  inFlightRequests.set(key, requestPromise);

  return requestPromise;
}

type PageResponse<T> = {
  data: T[];
  pagination?: {
    page: number;
    limit: number;
    hasMore: boolean;
    total: number;
    totalPages: number;
  };
};

async function fetchAllPages<T>(
  fetchPage: (query: string) => Promise<PageResponse<T>>,
  query = ""
) {
  const params = new URLSearchParams(
    query.startsWith("?") ? query.slice(1) : query
  );

  const items: T[] = [];
  const seenIds = new Set<string>();

  let page = 1;
  let hasMore = true;

  while (hasMore) {
    params.set("page", String(page));
    params.set("limit", "100");

    const result = await fetchPage(`?${params.toString()}`);

    for (const item of result.data) {
      const id =
        typeof item === "object" &&
        item !== null &&
        "id" in item &&
        typeof item.id === "string"
          ? item.id
          : null;

      if (!id || !seenIds.has(id)) {
        items.push(item);

        if (id) {
          seenIds.add(id);
        }
      }
    }

    hasMore = result.pagination?.hasMore ?? false;
    page += 1;
  }

  return items;
}

export const apiClient = {
  health: () =>
    api<{ status: string }>("/health"),

  readiness: () =>
    api<{
      status: string;
      error?: string;
      database?: string;
      redis?: string;
      websocket?: string;
    }>("/ready"),

  session: () =>
    api<{
      user: {
        id: string;
        email: string;
        organizationIds: string[];
      };
    }>("/auth/session"),

  logout: () =>
    api<void>("/auth/logout", {
      method: "POST",
    }),

  login: (body: {
    email: string;
    password: string;
  }) =>
    api<{
      user: {
        id: string;
        email: string;
        name: string;
      };
      accessToken: string;
      refreshToken: string;
    }>("/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  register: (body: {
    name: string;
    email: string;
    password: string;
  }) =>
    api<{
      user: {
        id: string;
        email: string;
        name: string;
      };
      accessToken: string;
      refreshToken: string;
    }>("/auth/register", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  refresh: (refreshToken: string) =>
    api<{
      accessToken: string;
      refreshToken: string;
    }>("/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    }),

  jobHandlers: () =>
    api<{
      data: Array<{
        type: string;
        label: string;
        description: string;
        payloadExample: Record<string, unknown>;
      }>;
    }>("/job-handlers"),

  projects: (query = "") =>
    api<PageResponse<Project>>(`/projects${query}`),

  allProjects: (query = "") =>
    fetchAllPages(
      (pageQuery) =>
        api<PageResponse<Project>>(`/projects${pageQuery}`),
      query
    ),

  createProject: (body: {
    name: string;
    description?: string;
  }) =>
    api<Project>("/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateProject: (
    id: string,
    body: {
      name?: string;
      description?: string | null;
    }
  ) =>
    api<Project>(`/projects/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteProject: (id: string) =>
    api<void>(`/projects/${id}`, {
      method: "DELETE",
    }),

  queues: (projectId: string, query = "") =>
    api<PageResponse<Queue>>(
      `/projects/${projectId}/queues${query}`
    ),

  allQueues: (projectId: string, query = "") =>
    fetchAllPages(
      (pageQuery) =>
        api<PageResponse<Queue>>(
          `/projects/${projectId}/queues${pageQuery}`
        ),
      query
    ),

  queueDepthHistory: (
    projectId: string,
    queueId: string,
    hours = 24
  ) =>
    api<{ data: QueueDepthSnapshot[] }>(
      `/projects/${projectId}/queues/${queueId}/metrics/history?hours=${hours}`
    ),

  workerUtilization: (projectId: string) =>
    api<{
      workers: WorkerUtilization[];
      aggregateUtilization: number | null;
    }>(
      `/projects/${projectId}/metrics/worker-utilization`
    ),

  retryPolicies: () =>
    api<{ data: RetryPolicy[] }>("/retry-policies"),

  createRetryPolicy: (body: {
    name: string;
    strategy: string;
    maxAttempts: number;
    initialDelayMs: number;
    maxDelayMs: number;
    backoffMultiplier: number;
    jitter?: boolean;
  }) =>
    api<RetryPolicy>("/retry-policies", {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateRetryPolicy: (
    id: string,
    body: Partial<{
      name: string;
      strategy: string;
      maxAttempts: number;
      initialDelayMs: number;
      maxDelayMs: number;
      backoffMultiplier: number;
      jitter: boolean;
    }>
  ) =>
    api<RetryPolicy>(`/retry-policies/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteRetryPolicy: (id: string) =>
    api<void>(`/retry-policies/${id}`, {
      method: "DELETE",
    }),

  createQueue: (
    projectId: string,
    body: {
      name: string;
      description?: string;
      defaultPriority?: number;
      concurrencyLimit: number;
      isPaused?: boolean;
      retryPolicyId: string;
    }
  ) =>
    api<Queue>(`/projects/${projectId}/queues`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  updateQueue: (
    id: string,
    body: Partial<Queue>
  ) =>
    api<Queue>(`/queues/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  jobs: (query = "", projectId?: string | null) =>
    api<PageResponse<Job>>(
      `/jobs${scopedQuery(query, projectId)}`
    ),

  allJobs: (
    projectId?: string | null,
    query = ""
  ) =>
    fetchAllPages(
      (pageQuery) =>
        api<PageResponse<Job>>(
          `/jobs${scopedQuery(pageQuery, projectId)}`
        ),
      query
    ),

  scheduledJobs: (
    query = "",
    projectId?: string | null
  ) =>
    api<PageResponse<ScheduledJob>>(
      `/scheduled-jobs${scopedQuery(query, projectId)}`
    ),

  allScheduledJobs: (
    projectId?: string | null,
    query = ""
  ) =>
    fetchAllPages(
      (pageQuery) =>
        api<PageResponse<ScheduledJob>>(
          `/scheduled-jobs${scopedQuery(pageQuery, projectId)}`
        ),
      query
    ),

  executionsList: (
    query = "",
    projectId?: string | null
  ) =>
    api<PageResponse<ExecutionRow>>(
      `/executions${scopedQuery(query, projectId)}`
    ),

  allExecutions: (
    projectId?: string | null,
    query = ""
  ) =>
    fetchAllPages(
      (pageQuery) =>
        api<PageResponse<ExecutionRow>>(
          `/executions${scopedQuery(pageQuery, projectId)}`
        ),
      query
    ),

  job: (id: string) =>
    api<Job & {
      executions: Execution[];
      deadLetterEntry?: DlqEntry | null;
    }>(`/jobs/${id}`),

  executions: (id: string) =>
    api<{ data: Execution[] }>(
      `/jobs/${id}/executions`
    ),

  createJob: (
    queueId: string,
    body: Record<string, unknown>,
    idempotencyKey?: string
  ) =>
    api<Job>(`/queues/${queueId}/jobs`, {
      method: "POST",
      headers: idempotencyKey
        ? { "Idempotency-Key": idempotencyKey }
        : {},
      body: JSON.stringify(body),
    }),

  createScheduledJob: (
    queueId: string,
    body: {
      jobType: string;
      payload: unknown;
      cronExpression: string;
      nextRunAt?: string;
      enabled?: boolean;
    }
  ) =>
    api<ScheduledJob>(
      `/queues/${queueId}/scheduled-jobs`,
      {
        method: "POST",
        body: JSON.stringify(body),
      }
    ),

  updateScheduledJob: (
    id: string,
    body: Partial<{
      jobType: string;
      payload: unknown;
      cronExpression: string;
      nextRunAt: string;
      enabled: boolean;
    }>
  ) =>
    api<ScheduledJob>(`/scheduled-jobs/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),

  deleteScheduledJob: (id: string) =>
    api<void>(`/scheduled-jobs/${id}`, {
      method: "DELETE",
    }),

  createBatch: (
    queueId: string,
    jobs: unknown[]
  ) =>
    api<JobBatch>(`/queues/${queueId}/jobs/batch`, {
      method: "POST",
      body: JSON.stringify({ jobs }),
    }),

  batchJobs: (
    batchId: string,
    projectId?: string | null,
    query = ""
  ) =>
    api<PageResponse<Job>>(
      `/jobs${scopedQuery(
        `?batchId=${encodeURIComponent(batchId)}${
          query
            ? `&${query.replace(/^\?/, "")}`
            : ""
        }`,
        projectId
      )}`
    ),

  cancel: (id: string) =>
    api<Job>(`/jobs/${id}/cancel`, {
      method: "POST",
    }),

  retry: (id: string) =>
    api<{
      job: Job;
      scheduled: boolean;
      delayMs: number | null;
    }>(`/jobs/${id}/retry`, {
      method: "POST",
    }),

  workers: (query = "") =>
    api<PageResponse<Worker>>(`/workers${query}`),

  heartbeats: (id: string) =>
    api<{
      data: Array<Record<string, unknown>>;
    }>(`/workers/${id}/heartbeats`),

  dlq: (
    query = "",
    projectId?: string | null
  ) =>
    api<PageResponse<DlqEntry>>(
      `/dlq${scopedQuery(query, projectId)}`
    ),

  allDlq: (
    projectId?: string | null,
    query = ""
  ) =>
    fetchAllPages(
      (pageQuery) =>
        api<PageResponse<DlqEntry>>(
          `/dlq${scopedQuery(pageQuery, projectId)}`
        ),
      query
    ),

  requeueDlq: (id: string) =>
    api<Record<string, unknown>>(
      `/dlq/${id}/requeue`,
      {
        method: "POST",
      }
    ),

  createApiKey: (name: string) =>
    api<Record<string, unknown>>(
      "/auth/api-keys",
      {
        method: "POST",
        body: JSON.stringify({ name }),
      }
    ),
};





















// import type { DlqEntry, Execution, ExecutionRow, Job, JobBatch, Project, Queue, QueueDepthSnapshot, RetryPolicy, ScheduledJob, Worker, WorkerUtilization } from "./types";

// const base = process.env.NEXT_PUBLIC_API_BASE_URL;
// if (!base) throw new Error("NEXT_PUBLIC_API_BASE_URL is required");

// export class ApiError extends Error { constructor(public status: number, message: string, public details?: Array<{ path?: string; message: string }>) { super(message); } }

// const inFlightRequests = new Map<string, Promise<unknown>>();
// export function setAccessToken(_token: string | null) {}
// export function getAccessToken() { return null; }

// export async function apiText(path: string): Promise<string> {
//   const response = await fetch(`${base}${path}`, { credentials: "include" });
//   const body = await response.text();
//   if (!response.ok) throw new ApiError(response.status, body || "Request failed");
//   return body;
// }

// function scopedQuery(query: string, projectId?: string | null) {
//   if (!projectId) return query;
//   const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
//   params.set("projectId", projectId);
//   return `?${params.toString()}`;
// }

// async function request<T>(path: string, options: RequestInit, token: string | null): Promise<{ response: Response; body: T }> {
//   const headers = new Headers(options.headers);
//   headers.set("Content-Type", "application/json");
//   const response = await fetch(`${base}${path}`, { ...options, credentials: "include", headers });
//   const body = await response.json().catch(() => ({})) as T;
//   return { response, body };
// }

// async function requestApi<T>(path: string, options: RequestInit = {}): Promise<T> {
//   let token = getAccessToken();
//   let { response, body } = await request<T>(path, options, token);
//   if (response.status === 401 && path !== "/auth/login" && path !== "/auth/register" && path !== "/auth/refresh" && path !== "/auth/session") {
//     const refreshResponse = await request<{ accessToken: string; refreshToken: string }>("/auth/refresh", { method: "POST" }, null);
//     if (refreshResponse.response.ok) {
//       ({ response, body } = await request<T>(path, options, null));
//     } else {
//       setAccessToken(null);
//     }
//   }
//   const errorMessage = typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "message" in body.error && typeof body.error.message === "string" ? body.error.message : "Request failed";
//   const errorDetails = typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "details" in body.error && Array.isArray(body.error.details) ? body.error.details as Array<{ path?: string; message: string }> : undefined;
//   if (!response.ok) throw new ApiError(response.status, errorMessage, errorDetails);
//   return body as T;
// }

// export function api<T>(path: string, options: RequestInit = {}): Promise<T> {
//   const key = `${options.method ?? "GET"}:${path}:${typeof options.body === "string" ? options.body : ""}`;
//   const existing = inFlightRequests.get(key) as Promise<T> | undefined;
//   if (existing) return existing;
//   const request = requestApi<T>(path, options).finally(() => inFlightRequests.delete(key));
//   inFlightRequests.set(key, request);
//   return request;
// }

// type PageResponse<T> = { data: T[]; pagination?: { page: number; limit: number; hasMore: boolean; total: number; totalPages: number } };

// async function fetchAllPages<T>(fetchPage: (query: string) => Promise<PageResponse<T>>, query = "") {
//   const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : query);
//   const items: T[] = [];
//   const seenIds = new Set<string>();
//   let page = 1;
//   let hasMore = true;
//   while (hasMore) {
//     params.set("page", String(page));
//     params.set("limit", "100");
//     const result = await fetchPage(`?${params.toString()}`);
//     for (const item of result.data) {
//       const id = typeof item === "object" && item !== null && "id" in item && typeof item.id === "string" ? item.id : null;
//       if (!id || !seenIds.has(id)) {
//         items.push(item);
//         if (id) seenIds.add(id);
//       }
//     }
//     hasMore = result.pagination?.hasMore ?? false;
//     page += 1;
//   }
//   return items;
// }

// export const apiClient = {
//   health: () => api<{ status: string }>("/health"),
//   readiness: () => api<{ status: string; error?: string; database?: string; redis?: string; websocket?: string }>("/ready"),
//   session: () => api<{ user: { id: string; email: string; organizationIds: string[] } }>("/auth/session"),
//   logout: () => api<void>("/auth/logout", { method: "POST" }),
//   login: (body: { email: string; password: string }) => api<{ user: { id: string; email: string; name: string }; accessToken: string; refreshToken: string }>("/auth/login", { method: "POST", body: JSON.stringify(body) }),
//   register: (body: { name: string; email: string; password: string }) => api<{ user: { id: string; email: string; name: string }; accessToken: string; refreshToken: string }>("/auth/register", { method: "POST", body: JSON.stringify(body) }),
//   refresh: (refreshToken: string) => api<{ accessToken: string; refreshToken: string }>("/auth/refresh", { method: "POST", body: JSON.stringify({ refreshToken }) }),
//   jobHandlers: () => api<{ data: Array<{ type: string; label: string; description: string; payloadExample: Record<string, unknown> }> }>("/job-handlers"),
//   projects: (query = "") => api<PageResponse<Project>>(`/projects${query}`),
//   allProjects: (query = "") => fetchAllPages((pageQuery) => api<PageResponse<Project>>(`/projects${pageQuery}`), query),
//   createProject: (body: { name: string; description?: string }) => api<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
//   updateProject: (id: string, body: { name?: string; description?: string | null }) => api<Project>(`/projects/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
//   deleteProject: (id: string) => api<void>(`/projects/${id}`, { method: "DELETE" }),
//   queues: (projectId: string, query = "") => api<PageResponse<Queue>>(`/projects/${projectId}/queues${query}`),
//   allQueues: (projectId: string, query = "") => fetchAllPages((pageQuery) => api<PageResponse<Queue>>(`/projects/${projectId}/queues${pageQuery}`), query),
//   queueDepthHistory: (projectId: string, queueId: string, hours = 24) => api<{ data: QueueDepthSnapshot[] }>(`/projects/${projectId}/queues/${queueId}/metrics/history?hours=${hours}`),
//   workerUtilization: (projectId: string) => api<{ workers: WorkerUtilization[]; aggregateUtilization: number | null }>(`/projects/${projectId}/metrics/worker-utilization`),
//   retryPolicies: () => api<{ data: RetryPolicy[] }>("/retry-policies"),
//   createRetryPolicy: (body: { name: string; strategy: string; maxAttempts: number; initialDelayMs: number; maxDelayMs: number; backoffMultiplier: number; jitter?: boolean }) => api<RetryPolicy>("/retry-policies", { method: "POST", body: JSON.stringify(body) }),
//   updateRetryPolicy: (id: string, body: Partial<{ name: string; strategy: string; maxAttempts: number; initialDelayMs: number; maxDelayMs: number; backoffMultiplier: number; jitter: boolean }>) => api<RetryPolicy>(`/retry-policies/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
//   deleteRetryPolicy: (id: string) => api<void>(`/retry-policies/${id}`, { method: "DELETE" }),
//   createQueue: (projectId: string, body: { name: string; description?: string; defaultPriority?: number; concurrencyLimit: number; isPaused?: boolean; retryPolicyId: string }) => api<Queue>(`/projects/${projectId}/queues`, { method: "POST", body: JSON.stringify(body) }),
//   updateQueue: (id: string, body: Partial<Queue>) => api<Queue>(`/queues/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
//   jobs: (query = "", projectId?: string | null) => api<PageResponse<Job>>(`/jobs${scopedQuery(query, projectId)}`),
//   allJobs: (projectId?: string | null, query = "") => fetchAllPages((pageQuery) => api<PageResponse<Job>>(`/jobs${scopedQuery(pageQuery, projectId)}`), query),
//   scheduledJobs: (query = "", projectId?: string | null) => api<PageResponse<ScheduledJob>>(`/scheduled-jobs${scopedQuery(query, projectId)}`),
//   allScheduledJobs: (projectId?: string | null, query = "") => fetchAllPages((pageQuery) => api<PageResponse<ScheduledJob>>(`/scheduled-jobs${scopedQuery(pageQuery, projectId)}`), query),
//   executionsList: (query = "", projectId?: string | null) => api<PageResponse<ExecutionRow>>(`/executions${scopedQuery(query, projectId)}`),
//   allExecutions: (projectId?: string | null, query = "") => fetchAllPages((pageQuery) => api<PageResponse<ExecutionRow>>(`/executions${scopedQuery(pageQuery, projectId)}`), query),
//   job: (id: string) => api<Job & { executions: Execution[]; deadLetterEntry?: DlqEntry | null }>(`/jobs/${id}`),
//   executions: (id: string) => api<{ data: Execution[] }>(`/jobs/${id}/executions`),
//   createJob: (queueId: string, body: Record<string, unknown>, idempotencyKey?: string) => api<Job>(`/queues/${queueId}/jobs`, { method: "POST", headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}, body: JSON.stringify(body) }),
//   createScheduledJob: (queueId: string, body: { jobType: string; payload: unknown; cronExpression: string; nextRunAt?: string; enabled?: boolean }) => api<ScheduledJob>(`/queues/${queueId}/scheduled-jobs`, { method: "POST", body: JSON.stringify(body) }),
//   updateScheduledJob: (id: string, body: Partial<{ jobType: string; payload: unknown; cronExpression: string; nextRunAt: string; enabled: boolean }>) => api<ScheduledJob>(`/scheduled-jobs/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
//   deleteScheduledJob: (id: string) => api<void>(`/scheduled-jobs/${id}`, { method: "DELETE" }),
//   createBatch: (queueId: string, jobs: unknown[]) => api<JobBatch>(`/queues/${queueId}/jobs/batch`, { method: "POST", body: JSON.stringify({ jobs }) }),
//   batchJobs: (batchId: string, projectId?: string | null, query = "") => api<PageResponse<Job>>(`/jobs${scopedQuery(`?batchId=${encodeURIComponent(batchId)}${query ? `&${query.replace(/^\?/, "")}` : ""}`, projectId)}`),
//   cancel: (id: string) => api<Job>(`/jobs/${id}/cancel`, { method: "POST" }),
//   retry: (id: string) => api<{ job: Job; scheduled: boolean; delayMs: number | null }>(`/jobs/${id}/retry`, { method: "POST" }),
//   workers: (query = "") => api<PageResponse<Worker>>(`/workers${query}`),
//   heartbeats: (id: string) => api<{ data: Array<Record<string, unknown>> }>(`/workers/${id}/heartbeats`),
//   dlq: (query = "", projectId?: string | null) => api<PageResponse<DlqEntry>>(`/dlq${scopedQuery(query, projectId)}`),
//   allDlq: (projectId?: string | null, query = "") => fetchAllPages((pageQuery) => api<PageResponse<DlqEntry>>(`/dlq${scopedQuery(pageQuery, projectId)}`), query),
//   requeueDlq: (id: string) => api<Record<string, unknown>>(`/dlq/${id}/requeue`, { method: "POST" }),
//   createApiKey: (name: string) => api<Record<string, unknown>>("/auth/api-keys", { method: "POST", body: JSON.stringify({ name }) })
// };
