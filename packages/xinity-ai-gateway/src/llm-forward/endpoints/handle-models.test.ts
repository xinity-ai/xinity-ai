import { describe, test, expect } from "bun:test";
import { replicaLifecycles } from "./handle-models";

const member = (lifecycle: "ready" | "installing" | null, id = "group-1") => ({ group: { id, size: 2 }, lifecycle });

describe("replicaLifecycles", () => {
  test("lists a group as its least ready member", () => {
    expect(replicaLifecycles([member("ready"), member("installing")])).toEqual(["installing"]);
    expect(replicaLifecycles([member("ready"), member("ready")])).toEqual(["ready"]);
  });

  test("lists a group with a member not placed as unknown, next to installations on one node", () => {
    expect(replicaLifecycles([member("ready"), { group: null, lifecycle: "ready" }])).toEqual(["ready", null]);
  });
});
