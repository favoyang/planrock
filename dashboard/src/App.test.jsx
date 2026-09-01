import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, copyText, filterPlans, formatRelativeDate, resolvePlanPath, stripPlanFrontmatter, workflowState } from "./main";
import { fetchAllPages } from "./pagination";

afterEach(() => vi.unstubAllGlobals());

describe("dashboard workflow", () => {
  it("resolves relative Markdown plan links across native path formats", () => {
    expect(resolvePlanPath("pending.md", "/tmp/plans/active.md")).toBe("/tmp/plans/pending.md");
    expect(resolvePlanPath("pending.md", "C:\\repo\\plans\\active.md")).toBe("C:/repo/plans/pending.md");
  });

  it("removes frontmatter before rendering a full plan", () => {
    expect(stripPlanFrontmatter("---\ntitle: Test\n---\n\n## Goal\n\nBody")).toBe("## Goal\n\nBody");
    expect(stripPlanFrontmatter("## Goal\n\nBody")).toBe("## Goal\n\nBody");
  });

  it("derives pending, active, and closed from authored state and progress signals", () => {
    expect(workflowState({ state: "open", checklistDone: 0, agentSessions: [] })).toBe("pending");
    expect(workflowState({ state: "open", checklistDone: 1, agentSessions: [] })).toBe("active");
    expect(workflowState({ state: "open", checklistDone: 0, agentSessions: ["codex:session"] })).toBe("active");
    expect(workflowState({ state: "closed", checklistDone: 0, agentSessions: [] })).toBe("closed");
  });

  it("filters the open lifecycle by its derived workflow", () => {
    const plans = [
      { state: "open", checklistDone: 0, agentSessions: [], title: "Pending", projectName: "Repo", relativeFile: "pending.md" },
      { state: "open", checklistDone: 1, agentSessions: [], title: "Active", projectName: "Repo", relativeFile: "active.md" },
      { state: "closed", checklistDone: 0, agentSessions: [], title: "Closed", projectName: "Repo", relativeFile: "closed.md" },
    ];
    expect(filterPlans(plans, { lifecycle: "open", workflow: "pending", project: null, query: "" }).map((plan) => plan.title)).toEqual(["Pending"]);
    expect(filterPlans(plans, { lifecycle: "open", workflow: "active", project: null, query: "" }).map((plan) => plan.title)).toEqual(["Active"]);
    expect(filterPlans(plans, { lifecycle: "closed", workflow: "active", project: null, query: "" }).map((plan) => plan.title)).toEqual(["Closed"]);
  });

  it("formats plan activity as relative time", () => {
    expect(formatRelativeDate("2026-09-01T10:00:00.000Z", new Date("2026-09-01T12:00:00.000Z"))).toBe("2 hours ago");
    expect(formatRelativeDate("2026-08-30", new Date("2026-09-01T00:00:00"))).toBe("2 days ago");
  });
});

describe("dashboard copy fallback", () => {
  it("copies through the document fallback when the Clipboard API is unavailable", async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execCommand = vi.fn(() => true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    try {
      await copyText("plan path");
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(document.querySelector("textarea")).toBeNull();
    } finally {
      if (clipboardDescriptor) Object.defineProperty(navigator, "clipboard", clipboardDescriptor); else delete navigator.clipboard;
      if (execCommandDescriptor) Object.defineProperty(document, "execCommand", execCommandDescriptor); else delete document.execCommand;
    }
  });
});

describe("dashboard pagination", () => {
  it("loads every bounded page instead of silently stopping at 200 items", async () => {
    const calls = [];
    const fetchPage = vi.fn(async (collection, cursor, limit) => {
      calls.push({ collection, cursor, limit });
      const offset = cursor ? Number(cursor) : 0;
      const items = Array.from({ length: Math.min(limit, 450 - offset) }, (_, index) => offset + index);
      return { items, nextCursor: offset + items.length < 450 ? String(offset + items.length) : null };
    });
    expect(await fetchAllPages(fetchPage, "openPlans", 1000)).toEqual(Array.from({ length: 450 }, (_, index) => index));
    expect(calls.map((call) => call.limit)).toEqual([200, 200, 200]);
  });
});

describe("dashboard navigation", () => {
  it("does not report healthy before overview data is available", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    render(<App />);

    expect(screen.getByRole("button", { name: "loading" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "healthy" })).toBeNull();
  });

  it("shows inline counts and filters open plans by derived workflow", async () => {
    let resolveRefresh;
    let rejectRefresh;
    const repositories = [
      { id: "active-repo", displayName: "Active repo", available: true, counts: { open: 2, closed: 1 } },
      { id: "long-repo", displayName: "This project name is deliberately extremely long for dropdown alignment", available: true, counts: { open: 12, closed: 0 } },
      { id: "empty-repo", displayName: "Empty repo", available: true, counts: { open: 0, closed: 0 } },
    ];
    const plans = [
      { id: "pending", projectId: "active-repo", projectName: "Active repo", title: "Pending plan", state: "open", priority: "P2", checklistDone: 0, checklistTotal: 2, agentSessions: [], relativeFile: "plans/pending.md", absolutePath: "/tmp/plans/pending.md", createdAt: "2026-08-30", updatedAt: "2026-08-30T06:00:00.000Z" },
      { id: "active", projectId: "active-repo", projectName: "Active repo", title: "Active plan", state: "open", priority: "P1", checklistDone: 1, checklistTotal: 2, agentSessions: ["codex:019e2f18-930f-7052-999f-e3b083d9373f"], relativeFile: "plans/active.md", absolutePath: "/tmp/plans/active.md", createdAt: "2026-08-30", updatedAt: "2026-08-31T06:00:00.000Z", goalExcerpt: "Read **the [collector docs](https://example.com/docs)** and [`pending.md`](pending.md).\n\n- Keep \\*literal\\*\n- Reject [bad](javascript:bad)" },
      { id: "closed", projectId: "active-repo", projectName: "Active repo", title: "Closed early", state: "closed", priority: "P3", checklistDone: 1, checklistTotal: 4, agentSessions: [], relativeFile: "plans/closed.md", absolutePath: "/tmp/plans/closed.md", createdAt: "2026-08-20", updatedAt: "2026-08-28T06:00:00.000Z", closedAt: "2026-08-29" },
    ];
    const fetchMock = vi.fn(async (url) => {
      if (url === "/api/refresh") return new Promise((resolve, reject) => { resolveRefresh = () => resolve({ ok: true, json: async () => ({}) }); rejectRefresh = reject; });
      if (String(url).startsWith("/api/plan?")) return { ok: true, text: async () => "---\ntitle: Active plan\n---\n\n## Goal\n\nRead **the [collector docs](https://example.com/docs)** and [`pending.md`](pending.md).\n\n- Keep \\*literal\\*\n- Reject [bad](javascript:bad)\n\n## Steps\n\n- [x] Source body\n- [ ] Review result\n" };
      if (url === "/api/overview") return { ok: true, json: async () => ({ refreshedAt: "2026-08-30T00:00:00.000Z", incomplete: false, health: { state: "healthy" }, summary: { projects: 3, open: 2, closed: 1, invalid: 0 }, diagnostics: [] }) };
      const collection = new URL(url, "http://localhost").searchParams.get("name");
      return { ok: true, json: async () => ({ items: collection === "repositories" ? repositories : collection === "openPlans" ? plans.filter((plan) => plan.state === "open") : plans.filter((plan) => plan.state === "closed"), nextCursor: null }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<App />);

    await screen.findByText("2 of 3");
    expect(container).toHaveTextContent("v1.2.4");
    expect(container).toHaveTextContent("Last refreshed");
    expect(container.textContent).toContain("Open 2");
    expect(container.textContent).toContain("Closed 1");
    expect(container.textContent).toContain("Pending 1");
    expect(container.textContent).toContain("Active 1");
    expect(container.textContent).toContain("Pending plan");
    expect(container.textContent).toContain("Active plan");
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();
    expect(screen.getByRole("heading", { name: "Plans - 2 matching" })).toHaveClass("section-kicker");
    const pendingTitleLine = screen.getByRole("heading", { name: "Pending plan" }).closest(".plan-title-line");
    expect(pendingTitleLine.querySelector(".priority")).toHaveTextContent("P2");
    expect(pendingTitleLine.querySelector(".workflow")).toHaveTextContent("Pending");

    const activeTimestamp = screen.getByRole("button", { name: "Active: show full timestamp" });
    expect(activeTimestamp).toHaveTextContent("Active");
    fireEvent.click(activeTimestamp);
    expect(activeTimestamp).toHaveAccessibleName("Active: show relative time");
    expect(activeTimestamp).toHaveTextContent("Aug 31, 2026");

    fireEvent.click(screen.getByRole("button", { name: "Open Active plan" }));
    const docsLink = await screen.findByRole("link", { name: "collector docs" });
    expect(docsLink).toHaveAttribute("href", "https://example.com/docs");
    expect(docsLink.closest("strong")).toHaveTextContent("the collector docs");
    expect(screen.getByRole("button", { name: "pending.md" }).querySelector("code")).toBeInTheDocument();
    expect(screen.getByText("Keep *literal*")).toBeInTheDocument();
    expect(screen.getByText("Reject bad")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
    const pathButton = screen.getByRole("button", { name: "/tmp/plans/active.md" });
    expect(document.querySelector(".plan-content").compareDocumentPosition(pathButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const planTasks = document.querySelectorAll(".plan-content .task-list-item input");
    expect(planTasks).toHaveLength(2); expect(planTasks[0]).toBeChecked(); expect(planTasks[1]).not.toBeChecked();
    expect(pathButton).toHaveClass("detail-meta-value");
    fireEvent.click(pathButton);
    expect(await screen.findByText(/Source body/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Hide source" })).toBeInTheDocument();
    const sessionLink = screen.getByRole("link", { name: "codex:019e2f18-930f-7052-999f-e3b083d9373f" });
    expect(sessionLink).toHaveAttribute("href", "codex://threads/019e2f18-930f-7052-999f-e3b083d9373f"); expect(sessionLink).toHaveClass("detail-meta-value");
    const detailUpdated = screen.getByRole("button", { name: "Updated: show full timestamp" });
    fireEvent.click(detailUpdated);
    expect(detailUpdated).toHaveAccessibleName("Updated: show relative time");
    fireEvent.click(document.querySelector(".mantine-Drawer-close"));

    const projectInput = container.querySelector('input[aria-label="Project"]');
    fireEvent.click(projectInput);
    await waitFor(() => expect(document.querySelectorAll('[role="option"]')).toHaveLength(2));
    const longOption = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent.includes("deliberately extremely long"));
    expect(longOption).toHaveTextContent("This project name is deliberately extremely long for dropdown alignment12 open");
    expect(longOption.querySelector(".project-option-name")).toHaveTextContent("This project name is deliberately extremely long for dropdown alignment");
    expect(longOption.querySelector(".project-option-count")).toHaveTextContent("12 open");

    fireEvent.keyDown(projectInput, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(projectInput, { key: "ArrowDown", code: "ArrowDown" });
    fireEvent.keyDown(projectInput, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(projectInput).toHaveValue("This project name is deliberately extremely long for dropdown alignment"));
    expect(projectInput.value).not.toContain("12 open");

    const healthButton = container.querySelector(".health-button");
    const refreshButton = [...container.querySelectorAll("button")].find((button) => button.textContent.includes("Refresh"));
    expect(healthButton).toHaveTextContent("healthy");
    fireEvent.click(refreshButton);
    await waitFor(() => { expect(healthButton).toHaveTextContent("loading"); expect(healthButton).toBeEnabled(); });
    fireEvent.click(healthButton);
    expect(await screen.findByRole("heading", { name: "loading" })).toBeInTheDocument();
    resolveRefresh();
    await waitFor(() => { expect(healthButton).toHaveTextContent("healthy"); expect(healthButton).toBeEnabled(); });
    await waitFor(() => expect(screen.getByRole("heading", { name: "healthy" })).toBeInTheDocument());
    fireEvent.click(document.querySelector(".mantine-Drawer-close"));

    fireEvent.click(refreshButton);
    await waitFor(() => expect(healthButton).toHaveTextContent("loading"));
    rejectRefresh(new Error("Refresh unavailable"));
    await waitFor(() => { expect(healthButton).toHaveTextContent("stale"); expect(healthButton).toBeEnabled(); });
    expect(container.querySelector('[role="alert"]')).toHaveTextContent("Refresh unavailable");

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("bootstrap"))).toBe(false);
  }, 60_000);
});
