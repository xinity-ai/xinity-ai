import { describe, expect, test } from "bun:test";
import { orderByWeight } from "./weighted-targets";

const targets = [
  { weight: 30, target: "from" },
  { weight: 70, target: "to" },
];

describe("orderByWeight", () => {
  test("draws a target by its share of the total weight", () => {
    expect(orderByWeight(targets, () => 0.69)).toEqual(["to", "from"]);
    expect(orderByWeight(targets, () => 0.71)).toEqual(["from", "to"]);
  });

  test("never draws a target of weight 0 but keeps it as the fallback", () => {
    const allOnTo = [{ weight: 0, target: "from" }, { weight: 100, target: "to" }];
    expect(orderByWeight(allOnTo, () => 0)).toEqual(["to", "from"]);
    expect(orderByWeight(allOnTo, () => 0.999)).toEqual(["to", "from"]);
  });

  test("returns nothing for no targets", () => {
    expect(orderByWeight([])).toEqual([]);
  });
});
