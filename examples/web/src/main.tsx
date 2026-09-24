import { LiveChatProvider, LiveChatWidget, Messenger, useMessenger, useUnreadCount } from "@kobecuppens/livechat-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";

const apiUrl = import.meta.env.VITE_LIVECHAT_API_URL ?? "http://localhost:8787";
const workspaceKey = import.meta.env.VITE_LIVECHAT_KEY ?? "pk_replace_me";

function Toolbar({ inline, setInline }: { inline: boolean; setInline: (v: boolean) => void }) {
  const messenger = useMessenger();
  const unread = useUnreadCount();
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
      <button type="button" onClick={() => messenger.open({ name: "new" })}>Start a chat</button>
      <button type="button" onClick={() => messenger.open()}>Open help center</button>
      <label>
        <input type="checkbox" checked={inline} onChange={(e) => setInline(e.target.checked)} /> Inline help page
      </label>
      <span>Unread: {unread}</span>
    </div>
  );
}

function App() {
  const [inline, setInline] = useState(false);
  return (
    <LiveChatProvider apiUrl={apiUrl} workspaceKey={workspaceKey} locale={navigator.language}>
      <main style={{ padding: 32, maxWidth: 900 }}>
        <h1>Example React app</h1>
        <Toolbar inline={inline} setInline={setInline} />
        {inline ? (
          <div style={{ height: 640 }}>
            <Messenger inline />
          </div>
        ) : (
          <p>The chat launcher is in the bottom-right corner.</p>
        )}
      </main>
      {!inline && <LiveChatWidget />}
    </LiveChatProvider>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
