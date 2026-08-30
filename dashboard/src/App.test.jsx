import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./main";
import { removeBootstrapFragment } from "./bootstrap";
import { fetchAllPages } from "./pagination";

describe("dashboard bootstrap", () => {
  it("removes the single-use token from the fragment before API use", () => {
    const replaceState = vi.fn();
    const token = removeBootstrapFragment({ hash: "#bootstrap=secret-token", pathname: "/", search: "" }, { replaceState });
    expect(token).toBe("secret-token");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
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
  it("exposes the selected view and project programmatically", async () => {
    const repository = { id: "repo-1", displayName: "Repo", available: true, counts: { open: 1, closed: 0 } };
    const plan = { id: "plan-1", projectId: repository.id, projectName: "Repo", title: "Ship it", state: "open", priority: "P1", checklistDone: 0, checklistTotal: 1, relativeFile: "plans/ship.md" };
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (url === "/api/overview") return { ok: true, json: async () => ({ refreshedAt: "2026-08-30T00:00:00.000Z", incomplete: false, health: { state: "healthy" }, summary: { projects: 1, open: 1, closed: 0, invalid: 0 }, diagnostics: [], nextUp: [] }) };
      const collection = new URL(url, "http://localhost").searchParams.get("name");
      return { ok: true, json: async () => ({ items: collection === "repositories" ? [repository] : collection === "openPlans" ? [plan] : [], nextCursor: null }) };
    }));
    render(<App />);
    expect(await screen.findByRole("button", { name: "Next up" })).toHaveAttribute("aria-pressed", "true");
    const open = screen.getByRole("button", { name: "Open" }); fireEvent.click(open); expect(open).toHaveAttribute("aria-pressed", "true");
    const allProjects = screen.getByRole("button", { name: "All projects" }); expect(allProjects).toHaveAttribute("aria-pressed", "true");
    const repo = screen.getByRole("button", { name: /^Repo 1 open/ }); fireEvent.click(repo); expect(repo).toHaveAttribute("aria-pressed", "true"); expect(allProjects).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(screen.getByRole("button", { name: "Next up" })); expect(screen.getByRole("button", { name: /Ship it/ })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
