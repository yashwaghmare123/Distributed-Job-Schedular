import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";
import LoginPage from "@/app/login/page";
import RegisterPage from "@/app/register/page";
import ScheduledPage from "@/app/(app)/scheduled/page";
import ExecutionsPage from "@/app/(app)/executions/page";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push: vi.fn() }), useParams: () => ({ id: "job-1" }) }));
vi.mock("@/lib/api", () => ({ apiClient: { scheduledJobs: vi.fn(), executionsList: vi.fn(), login: vi.fn(), register: vi.fn() }, setAccessToken: vi.fn() }));
vi.mock("@/lib/socket", () => ({ connectSocket: vi.fn(), disconnectSocket: vi.fn(), subscribeSocket: vi.fn(() => () => undefined), subscribeSocketStatus: vi.fn((listener: (status: "DISCONNECTED") => void) => { listener("DISCONNECTED"); return () => undefined; }), getRecentSocketEvents: vi.fn(() => []), isSocketConnected: vi.fn(() => false) }));

const { apiClient } = await import("@/lib/api");

describe("dashboard boundary pages", () => {
  beforeEach(() => { vi.clearAllMocks(); sessionStorage.clear(); });
  it("renders login and registration forms", () => { render(<LoginPage />); expect(screen.getByRole("button", { name: "Open workspace" })).toBeInTheDocument(); render(<RegisterPage />); expect(screen.getByRole("button", { name: "Create workspace" })).toBeInTheDocument(); });
  it("renders scheduled data and empty state", async () => { vi.mocked(apiClient.scheduledJobs).mockResolvedValue({ data: [{ id: "s1", queueId: "q1", jobType: "digest", payload: {}, cronExpression: "0 * * * *", nextRunAt: "2026-08-23T12:00:00Z", enabled: true, queue: { id: "q1", name: "email", projectId: "p1" } }], pagination: { page: 1, limit: 100, hasMore: false, total: 1, totalPages: 1 } }); render(<ScheduledPage />); expect(await screen.findByText("digest")).toBeInTheDocument(); });
  it("renders execution data and empty state", async () => { vi.mocked(apiClient.executionsList).mockResolvedValue({ data: [], pagination: { page: 1, limit: 100, hasMore: false, total: 0, totalPages: 0 } }); render(<ExecutionsPage />); expect(await screen.findByText("No executions found.")).toBeInTheDocument(); });
  it("shows API errors", async () => { vi.mocked(apiClient.scheduledJobs).mockRejectedValue(new Error("Forbidden")); render(<ScheduledPage />); expect(await screen.findByText("Forbidden")).toBeInTheDocument(); });
  it("validates login required fields", async () => { render(<LoginPage />); fireEvent.click(screen.getByRole("button", { name: "Open workspace" })); await waitFor(() => expect(apiClient.login).not.toHaveBeenCalled()); });
});
