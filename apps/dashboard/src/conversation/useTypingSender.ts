import type { ReconnectingSocket } from "@kobecuppens/livechat-core";
import type { ServerEvent } from "@kobecuppens/livechat-protocol";
import { useCallback, useRef, type RefObject } from "react";

/** Throttled "agent is typing" signal: at most every 3s while typing, and a stop after 4s idle. */
export function useTypingSender(socketRef: RefObject<ReconnectingSocket<ServerEvent> | null>) {
  const lastSent = useRef(0);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendTyping = useCallback(
    (typing: boolean) => {
      const now = Date.now();
      if (typing && now - lastSent.current > 3000) {
        socketRef.current?.send({ type: "typing", typing: true });
        lastSent.current = now;
      }
      if (idleTimer.current) clearTimeout(idleTimer.current);
      if (typing) {
        idleTimer.current = setTimeout(() => sendTyping(false), 4000);
      } else if (lastSent.current) {
        socketRef.current?.send({ type: "typing", typing: false });
        lastSent.current = 0;
      }
    },
    [socketRef],
  );
  return sendTyping;
}
