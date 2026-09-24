import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Link, Router, useRouter } from "./router";

let nav: ReturnType<typeof useRouter>;

function Probe() {
  nav = useRouter();
  return <output data-testid="path">{nav.path}</output>;
}

const shownPath = () => screen.getByTestId("path").textContent;

function renderRouter(start: string, extra?: React.ReactNode) {
  history.replaceState(null, "", start);
  return render(
    <Router>
      <Probe />
      {extra}
    </Router>,
  );
}

beforeEach(() => {
  history.replaceState(null, "", "/");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  history.replaceState(null, "", "/");
});

describe("Router", () => {
  it("starts from the current location", () => {
    renderRouter("/w/ws_1/inbox");
    expect(shownPath()).toBe("/w/ws_1/inbox");
  });

  it("pushes a history entry on navigate and replaces it when asked", () => {
    renderRouter("/a");
    const push = vi.spyOn(history, "pushState");
    const replace = vi.spyOn(history, "replaceState");

    act(() => nav.navigate("/b"));
    expect(push).toHaveBeenCalledWith(null, "", "/b");
    expect(replace).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/b");
    expect(shownPath()).toBe("/b");

    act(() => nav.navigate("/c", true));
    expect(replace).toHaveBeenCalledWith(null, "", "/c");
    expect(push).toHaveBeenCalledTimes(1);
    expect(shownPath()).toBe("/c");
  });

  it("ignores navigation to the current path and strips query strings from the route path", () => {
    renderRouter("/a");
    const push = vi.spyOn(history, "pushState");

    act(() => nav.navigate("/a"));
    expect(push).not.toHaveBeenCalled();

    act(() => nav.navigate("/b?tab=x#h"));
    expect(location.search).toBe("?tab=x");
    expect(shownPath()).toBe("/b");
  });

  it("follows back/forward via popstate and stops listening after unmount", () => {
    const { unmount } = renderRouter("/a");
    act(() => nav.navigate("/b"));

    act(() => {
      history.replaceState(null, "", "/a");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(shownPath()).toBe("/a");

    const remove = vi.spyOn(window, "removeEventListener");
    unmount();
    expect(remove).toHaveBeenCalledWith("popstate", expect.any(Function));
  });

  it("provides a harmless default outside a Router", () => {
    render(<Probe />);
    expect(shownPath()).toBe("/");
    expect(() => nav.navigate("/x")).not.toThrow();
  });
});

describe("Link", () => {
  it("renders an href, calls onClick and navigates client-side on a plain click", () => {
    const onClick = vi.fn();
    renderRouter(
      "/a",
      <Link to="/w/ws_1/faq" className="nav-link" onClick={onClick}>
        Help
      </Link>,
    );
    const push = vi.spyOn(history, "pushState");
    const a = screen.getByRole("link", { name: "Help" });
    expect(a.getAttribute("href")).toBe("/w/ws_1/faq");
    expect(a.className).toBe("nav-link");

    const notPrevented = fireEvent.click(a);

    expect(notPrevented).toBe(false);
    expect(onClick).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith(null, "", "/w/ws_1/faq");
    expect(shownPath()).toBe("/w/ws_1/faq");
  });

  it.each([
    ["metaKey", { metaKey: true }],
    ["ctrlKey", { ctrlKey: true }],
    ["shiftKey", { shiftKey: true }],
    ["middle button", { button: 1 }],
  ])("leaves %s clicks to the browser", (_label, init) => {
    const onClick = vi.fn();
    renderRouter("/a", <Link to="/b" onClick={onClick}>Go</Link>);
    const push = vi.spyOn(history, "pushState");
    const a = screen.getByRole("link", { name: "Go" });
    // Record whether the Link prevented the default, then swallow it so happy-dom doesn't "open" the href.
    let linkPrevented: boolean | undefined;
    document.addEventListener(
      "click",
      (e) => {
        linkPrevented = e.defaultPrevented;
        e.preventDefault();
      },
      { once: true },
    );

    fireEvent.click(a, init);

    expect(linkPrevented).toBe(false);
    expect(onClick).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
    expect(shownPath()).toBe("/a");
  });
});
