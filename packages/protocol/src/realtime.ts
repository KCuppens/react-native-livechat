import { z } from "zod";
import { ConversationStatus, Message } from "./chat";
import { Timestamp } from "./common";

/** Events the server pushes over a conversation WebSocket. */
export const ServerEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.created"), message: Message }),
  z.object({
    type: z.literal("typing"),
    authorType: z.enum(["contact", "agent"]),
    name: z.string().nullable(),
    typing: z.boolean(),
  }),
  z.object({ type: z.literal("read"), authorType: z.enum(["contact", "agent"]), at: Timestamp }),
  z.object({
    type: z.literal("status.changed"),
    status: ConversationStatus,
    assigneeId: z.string().nullable(),
  }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

/** Events a client may send over a conversation WebSocket. Messages go through REST. */
export const ClientEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("typing"), typing: z.boolean() }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientEvent = z.infer<typeof ClientEvent>;
