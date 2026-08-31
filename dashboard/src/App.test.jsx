import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App, filterPlans, workflowState } from "./main";
import { fetchAllPages } from "./pagination";

afterEach(() => vi.unstubAllGlobals());

describe("dashboard workflow", () => {
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
  it("shows inline counts and filters open plans by derived workflow", async () => {
    const repositories = [
      { id: "active-repo", displayName: "Active repo", available: true, counts: { open: 2, closed: 1 } },
      { id: "empty-repo", displayName: "Empty repo", available: true, counts: { open: 0, closed: 0 } },
    ];
    const plans = [
      { id: "pending", projectId: "active-repo", projectName: "Active repo", title: "Pending plan", state: "open", priority: "P2", checklistDone: 0, checklistTotal: 2, agentSessions: [], relativeFile: "plans/pending.md", createdAt: "2026-08-30" },
      { id: "active", projectId: "active-repo", projectName: "Active repo", title: "Active plan", state: "open", priority: "P1", checklistDone: 1, checklistTotal: 2, agentSessions: [], relativeFile: "plans/active.md", createdAt: "2026-08-30" },
      { id: "closed", projectId: "active-repo", projectName: "Active repo", title: "Closed early", state: "closed", priority: "P3", checklistDone: 1, checklistTotal: 4, agentSessions: [], relativeFile: "plans/closed.md", createdAt: "2026-08-20", closedAt: "2026-08-29" },
    ];
    const fetchMock = vi.fn(async (url) => {
      if (url === "/api/overview") return { ok: true, json: async () => ({ refreshedAt: "2026-08-30T00:00:00.000Z", incomplete: false, health: { state: "healthy" }, summary: { projects: 2, open: 2, closed: 1, invalid: 0 }, diagnostics: [] }) };
      const collection = new URL(url, "http://localhost").searchParams.get("name");
      return { ok: true, json: async () => ({ items: collection === "repositories" ? repositories : collection === "openPlans" ? plans.filter((plan) => plan.state === "open") : plans.filter((plan) => plan.state === "closed"), nextCursor: null }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<App />);

    await screen.findByText("1 of 2 projects shown");
    expect(container.textContent).toContain("Open 2");
    expect(container.textContent).toContain("Closed 1");
    expect(container.textContent).toContain("Pending 1");
    expect(container.textContent).toContain("Active 1");
    expect(container.textContent).toContain("Pending plan");
    expect(container.textContent).toContain("Active plan");
    expect(container.querySelector('input[type="checkbox"]')).toBeChecked();

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("bootstrap"))).toBe(false);
  }, 20_000);
});
