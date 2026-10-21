import { describe, it, expect } from "bun:test";
import { stripBlockedVllmArgs } from "./model-primitives";

describe("stripBlockedVllmArgs", () => {
  it("drops a blocked flag together with its value, in long and short form", () => {
    expect(stripBlockedVllmArgs(["--tensor-parallel-size", "4", "--max-num-seqs", "8"])).toEqual(["--max-num-seqs", "8"]);
    expect(stripBlockedVllmArgs(["-tp", "2", "-pp", "2", "--enforce-eager"])).toEqual(["--enforce-eager"]);
  });

  it("drops a blocked flag written with =, without swallowing the next argument", () => {
    expect(stripBlockedVllmArgs(["--tensor-parallel-size=4", "--max-num-seqs", "8"])).toEqual(["--max-num-seqs", "8"]);
  });

  it("drops a blocked switch without swallowing a short flag after it", () => {
    expect(stripBlockedVllmArgs(["--trust-remote-code", "-O3", "--max-num-seqs", "8"])).toEqual(["-O3", "--max-num-seqs", "8"]);
    expect(stripBlockedVllmArgs(["--enable-auto-tool-choice", "-q", "fp8"])).toEqual(["-q", "fp8"]);
  });

  it("keeps flags that only share a prefix with a blocked one", () => {
    expect(stripBlockedVllmArgs(["--port-range", "5"])).toEqual(["--port-range", "5"]);
  });
});
