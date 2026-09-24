import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Avatar, Field, initials, Spinner, timeAgo, toast, Toaster } from "./ui";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("initials", () => {
  it("uses the first letter of the first and last word, uppercased", () => {
    expect(initials("alex agent")).toBe("AA");
    expect(initials("Mary Jane van Dyke")).toBe("MD");
    expect(initials("  bo   other  ")).toBe("BO");
  });

  it("uses a single letter for one-word names", () => {
    expect(initials("cher")).toBe("C");
  });

  it("falls back to ? for missing names", () => {
    expect(initials(null)).toBe("?");
    expect(initials(undefined)).toBe("?");
    expect(initials("")).toBe("?");
  });

  it("returns an empty string for whitespace-only names", () => {
    expect(initials("   ")).toBe("");
  });
});

describe("Avatar", () => {
  it("renders the image when a url is given", () => {
    const { container } = render(<Avatar name="Alex Agent" url="https://img.test/a.png" />);
    const img = container.querySelector(".avatar img") as HTMLImageElement;
    expect(img.src).toBe("https://img.test/a.png");
    expect(img.alt).toBe("");
    expect(container.querySelector(".avatar")!.textContent).toBe("");
  });

  it("renders initials without a url", () => {
    const { container } = render(<Avatar name="Alex Agent" url={null} />);
    expect(container.querySelector(".avatar img")).toBeNull();
    expect(container.querySelector(".avatar")!.textContent).toBe("AA");
  });
});

describe("Spinner", () => {
  it("is an accessible loading status", () => {
    render(<Spinner />);
    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
  });
});

describe("timeAgo", () => {
  const NOW = new Date("2026-03-15T12:00:00Z").getTime();

  it("buckets into now / minutes / hours / days", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(timeAgo(NOW)).toBe("now");
    expect(timeAgo(NOW - 59_000)).toBe("now");
    expect(timeAgo(NOW - 60_000)).toBe("1m");
    expect(timeAgo(NOW - 59 * 60_000)).toBe("59m");
    expect(timeAgo(NOW - 3_600_000)).toBe("1h");
    expect(timeAgo(NOW - 23 * 3_600_000)).toBe("23h");
    expect(timeAgo(NOW - 86_400_000)).toBe("1d");
    expect(timeAgo(NOW - 6 * 86_400_000)).toBe("6d");
  });

  it("shows a short date for timestamps a week or older", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const old = NOW - 7 * 86_400_000;
    expect(timeAgo(old)).toBe(new Date(old).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
    expect(timeAgo(old)).not.toMatch(/^\d+d$/);
  });
});

describe("toast / Toaster", () => {
  it("shows the message and hides it after 3 seconds", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    expect(screen.queryByRole("status")).toBeNull();

    act(() => toast("Saved"));
    expect(screen.getByRole("status").textContent).toBe("Saved");

    act(() => vi.advanceTimersByTime(2999));
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("replaces the message and restarts the timer on a new toast", () => {
    vi.useFakeTimers();
    render(<Toaster />);
    act(() => toast("First"));
    act(() => vi.advanceTimersByTime(2000));
    act(() => toast("Second"));
    expect(screen.getByRole("status").textContent).toBe("Second");

    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText("Second")).toBeTruthy();
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("Field", () => {
  it("renders the label, the control and the hint", () => {
    render(
      <Field label="Email" hint="We never share it.">
        <input />
      </Field>,
    );
    // The hint lives inside the <label>, so the accessible label text is "Email" + hint.
    const input = screen.getByLabelText(/^Email/);
    expect(input.tagName).toBe("INPUT");
    expect(input.closest("label")!.querySelector("span")!.textContent).toBe("Email");
    expect(screen.getByText("We never share it.").tagName).toBe("SMALL");
  });

  it("omits the hint when none is given", () => {
    const { container } = render(
      <Field label="Name">
        <input />
      </Field>,
    );
    expect(container.querySelector("small")).toBeNull();
    expect(container.querySelector(".field > span")!.textContent).toBe("Name");
  });
});
