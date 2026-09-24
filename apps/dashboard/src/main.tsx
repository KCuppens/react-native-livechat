import { MESSENGER_CSS } from "@kobecuppens/livechat-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n";
import { Router } from "./router";
import "./styles.css";

// Reuse the SDK's markdown styles (scoped under .lc-md) for previews and message bodies.
const md = document.createElement("style");
md.textContent = MESSENGER_CSS.split("\n").filter((l) => l.startsWith(".lc-md")).join("\n");
document.head.appendChild(md);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <Router>
          <App />
        </Router>
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);
