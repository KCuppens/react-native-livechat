import { describe, expect, it } from "vitest";
import { match } from "./router";

describe("match", () => {
  it("matches required and optional params", () => {
    expect(match("/w/:ws/:section?/:id?", "/w/ws_1/inbox/cv_2")).toEqual({ ws: "ws_1", section: "inbox", id: "cv_2" });
    expect(match("/w/:ws/:section?/:id?", "/w/ws_1")).toEqual({ ws: "ws_1" });
  });

  it("rejects mismatches and extra segments", () => {
    expect(match("/w/:ws/:section?", "/x/ws_1")).toBeNull();
    expect(match("/w/:ws", "/w/ws_1/inbox")).toBeNull();
  });

  it("decodes params", () => {
    expect(match("/w/:ws", "/w/a%20b")).toEqual({ ws: "a b" });
  });
});
