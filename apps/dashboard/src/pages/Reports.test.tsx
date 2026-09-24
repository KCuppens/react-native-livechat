import type { CsatReport } from "@kobecuppens/livechat-protocol";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Router } from "../router";
import { ReportsPage } from "./Reports";

function report(over: Partial<CsatReport> = {}): CsatReport {
  return {
    days: 30,
    responses: 10,
    average: 4,
    distribution: [1, 0, 2, 3, 4],
    conversations: 42,
    resolved: 37,
    medianFirstResponseMinutes: 12.4,
    recentComments: [],
    ...over,
  };
}

/** Answers GET /agent/w/ws_1/reports?days=N with `byDays[N]`. */
function stubReports(byDays: Record<number, CsatReport>) {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      urls.push(url);
      const m = /^\/agent\/w\/ws_1\/reports\?days=(\d+)$/.exec(url);
      const body = m ? byDays[Number(m[1])] : undefined;
      return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ error: { code: "not_found", message: url } }), { status: 404 });
    }),
  );
  return urls;
}

function renderPage() {
  history.replaceState(null, "", "/w/ws_1/reports");
  return render(
    <Router>
      <ReportsPage workspaceId="ws_1" />
    </Router>,
  );
}

const stat = (label: string) => screen.getByText(label).closest(".stat")!.querySelector("strong")!.textContent;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  history.replaceState(null, "", "/");
});

describe("ReportsPage", () => {
  it("loads the last 30 days and renders the stat tiles and rating bars", async () => {
    const urls = stubReports({ 30: report() });
    renderPage();
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();

    await screen.findByText("Conversations");
    expect(urls).toEqual(["/agent/w/ws_1/reports?days=30"]);
    expect((screen.getByLabelText("Period") as HTMLSelectElement).value).toBe("30");
    expect(stat("Conversations")).toBe("42");
    expect(stat("Resolved")).toBe("37");
    expect(stat("Median first reply")).toBe("12m");
    expect(stat("Satisfaction")).toBe("4.0 / 5");
    expect(screen.getByText("10 ratings")).toBeTruthy();

    // Bars are listed from 5 down to 1 and scaled against the largest bucket.
    const bars = screen.getAllByRole("img");
    expect(bars.map((b) => b.getAttribute("aria-label"))).toEqual([
      "4 ratings of 5",
      "3 ratings of 4",
      "2 ratings of 3",
      "0 ratings of 2",
      "1 rating of 1",
    ]);
    expect((bars[0]!.querySelector("i") as HTMLElement).style.width).toBe("100%");
    expect((bars[1]!.querySelector("i") as HTMLElement).style.width).toBe("75%");
    expect((bars[3]!.querySelector("i") as HTMLElement).style.width).toBe("0%");
    expect(screen.getByText("No comments yet.")).toBeTruthy();
  });

  it.each([
    [0.4, "<1m"],
    [1, "1m"],
    [59.4, "59m"],
    [60, "1h"],
    [150, "3h"],
    [1439, "24h"],
    [1440, "1d"],
    [4000, "3d"],
  ])("formats a median first reply of %s minutes as %s", async (minutes, text) => {
    stubReports({ 30: report({ medianFirstResponseMinutes: minutes }) });
    renderPage();
    await screen.findByText("Conversations");
    expect(stat("Median first reply")).toBe(text);
  });

  it("shows dashes when there is no reply time or rating yet, and empty bars", async () => {
    stubReports({ 30: report({ medianFirstResponseMinutes: null, average: null, responses: 0, distribution: [0, 0, 0, 0, 0] }) });
    renderPage();
    await screen.findByText("Conversations");

    expect(stat("Median first reply")).toBe("—");
    expect(stat("Satisfaction")).toBe("—");
    expect(screen.getByText("0 ratings")).toBeTruthy();
    for (const bar of screen.getAllByRole("img")) expect((bar.querySelector("i") as HTMLElement).style.width).toBe("0%");
  });

  it("lists recent comments with stars and links to the conversation", async () => {
    stubReports({
      30: report({
        recentComments: [
          { conversationId: "cv_1", score: 5, comment: "Super fast", at: 1 },
          { conversationId: "cv_2", score: 2, comment: "Too slow", at: 2 },
        ],
      }),
    });
    renderPage();
    await screen.findByText("“Super fast”");

    expect(screen.queryByText("No comments yet.")).toBeNull();
    const rows = screen.getAllByRole("row");
    expect(within(rows[0]!).getByText("★★★★★")).toBeTruthy();
    expect(within(rows[1]!).getByText("★★")).toBeTruthy();
    expect(within(rows[1]!).getByText("“Too slow”")).toBeTruthy();

    const link = within(rows[1]!).getByRole("link", { name: "Open" });
    expect(link.getAttribute("href")).toBe("/w/ws_1/inbox/cv_2");
    fireEvent.click(link);
    expect(location.pathname).toBe("/w/ws_1/inbox/cv_2");
  });

  it("reloads for the selected period", async () => {
    const urls = stubReports({ 30: report(), 7: report({ conversations: 5 }), 90: report({ conversations: 120 }) });
    renderPage();
    await screen.findByText("Conversations");

    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "7" } });
    await waitFor(() => expect(stat("Conversations")).toBe("5"));
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "90" } });
    await waitFor(() => expect(stat("Conversations")).toBe("120"));

    expect(urls).toEqual(["/agent/w/ws_1/reports?days=30", "/agent/w/ws_1/reports?days=7", "/agent/w/ws_1/reports?days=90"]);
  });
});

describe("ReportsPage regressions", () => {
  it("shows an error with Retry instead of an endless spinner", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        fail ? new Response(JSON.stringify({ error: { code: "internal_error", message: "x" } }), { status: 500 }) : new Response(JSON.stringify(report())),
      ),
    );
    renderPage();
    expect(await screen.findByText(/Couldn't load the report/)).toBeTruthy();
    expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("Conversations")).toBeTruthy();
  });

  it("ignores a slow response for a period that is no longer selected", async () => {
    let release30!: () => void;
    const slow30 = new Promise<void>((r) => (release30 = r));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const days = Number(/days=(\d+)/.exec(url)![1]);
        if (days === 30) await slow30;
        return new Response(JSON.stringify(report({ days, conversations: days })));
      }),
    );
    renderPage();
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "7" } });
    await waitFor(() => expect(stat("Conversations")).toBe("7"));
    release30();
    await new Promise((r) => setTimeout(r, 20));
    expect(stat("Conversations")).toBe("7");
  });
});
