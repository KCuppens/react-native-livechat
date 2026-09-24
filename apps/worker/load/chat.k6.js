// Load test for the public SDK paths. Run manually against a STAGING deployment, never prod:
//   k6 run -e BASE_URL=https://livechat-staging.example.workers.dev -e KEY=pk_... apps/worker/load/chat.k6.js
// Each virtual user is its own anonymous contact (unique device id), so per-contact rate limits
// (30 messages/min) aren't what's measured. Session creation is limited per IP (20/min): run
// from several machines or raise SESSION_LIMITER on staging to push the session scenario hard.
import http from "k6/http";
import ws from "k6/ws";
import { check, sleep } from "k6";
import { randomString } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";

const BASE = __ENV.BASE_URL;
const KEY = __ENV.KEY;
const WS_BASE = BASE.replace(/^http/, "ws");

export const options = {
  scenarios: {
    chat: {
      executor: "ramping-vus",
      exec: "chat",
      startVUs: 0,
      stages: [
        { duration: "1m", target: 50 },
        { duration: "3m", target: 200 },
        { duration: "1m", target: 0 },
      ],
    },
    faq: {
      executor: "constant-arrival-rate",
      exec: "faq",
      rate: 50,
      timeUnit: "1s",
      duration: "5m",
      preAllocatedVUs: 50,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:message}": ["p(95)<500", "p(99)<1200"],
    "http_req_duration{kind:faq}": ["p(95)<250"],
    ws_connecting: ["p(95)<800"],
  },
};

const json = (token) => ({
  headers: { "Content-Type": "application/json", "X-Livechat-Key": KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
});

function session() {
  const res = http.post(`${BASE}/v1/session`, JSON.stringify({ deviceId: randomString(32, "abcdef0123456789") }), { ...json(), tags: { kind: "session" } });
  check(res, { "session 200": (r) => r.status === 200 });
  return res.json("token");
}

export function chat() {
  const token = session();
  const start = http.post(`${BASE}/v1/conversations`, JSON.stringify({ clientId: `k6_${randomString(16)}`, body: "Load test: hello" }), {
    ...json(token),
    tags: { kind: "message" },
  });
  check(start, { "start 201": (r) => r.status === 201 });
  const conversationId = start.json("conversation.id");

  // Hold a socket open (like an open chat) while sending a few messages.
  ws.connect(`${WS_BASE}/v1/conversations/${conversationId}/ws?key=${KEY}&token=${token}`, { tags: { kind: "socket" } }, (socket) => {
    socket.on("open", () => {
      for (let i = 0; i < 5; i++) {
        const res = http.post(
          `${BASE}/v1/conversations/${conversationId}/messages`,
          JSON.stringify({ clientId: `k6_${randomString(16)}`, body: `message ${i}` }),
          { ...json(token), tags: { kind: "message" } },
        );
        check(res, { "message 201": (r) => r.status === 201 });
        socket.send(JSON.stringify({ type: "typing", typing: true }));
        sleep(1 + Math.random() * 2);
      }
      socket.close();
    });
    socket.setTimeout(() => socket.close(), 30_000);
  });
}

const QUERIES = ["refund", "password", "billing", "cancel subscription", "invoice", "login"];

export function faq() {
  const q = QUERIES[Math.floor(Math.random() * QUERIES.length)];
  const res = http.get(`${BASE}/v1/faq/articles?q=${encodeURIComponent(q)}&locale=en`, { ...json(), tags: { kind: "faq" } });
  check(res, { "faq 200": (r) => r.status === 200 });
}
