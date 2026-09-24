import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

const RouterContext = createContext<{ path: string; navigate: (to: string, replace?: boolean) => void }>({
  path: "/",
  navigate: () => {},
});

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const navigate = (to: string, replace = false) => {
    if (to === location.pathname) return;
    history[replace ? "replaceState" : "pushState"](null, "", to);
    setPath(new URL(to, location.origin).pathname);
  };
  return <RouterContext.Provider value={{ path, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  return useContext(RouterContext);
}

/** Matches "/w/:ws/inbox/:id?" style patterns; returns params or null. */
export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split("/").filter(Boolean);
  const s = path.split("/").filter(Boolean);
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const part = p[i]!;
    const optional = part.endsWith("?");
    const name = part.replace(/^:/, "").replace(/\?$/, "");
    if (part.startsWith(":")) {
      if (s[i] === undefined) {
        if (optional) continue;
        return null;
      }
      params[name] = decodeURIComponent(s[i]!);
    } else if (part !== s[i]) {
      return null;
    }
  }
  return s.length <= p.length ? params : null;
}

export function Link({ to, children, className, onClick }: { to: string; children: ReactNode; className?: string; onClick?: () => void }) {
  const { navigate } = useRouter();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onClick?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
