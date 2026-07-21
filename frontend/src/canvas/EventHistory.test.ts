import { describe, expect, it } from "vitest";

import { EventHistory } from "./EventHistory";

describe("EventHistory", () => {
  it("keeps only the most recent samples", () => {
    const history = new EventHistory(3);
    const size = { width: 100, height: 100 };
    for (let x = 1; x <= 5; x++) {
      history.add({ x, y: 50, value: 1 }, size);
    }

    expect(history.project(size).map((point) => point.x)).toEqual([3, 4, 5]);
    expect(history.length).toBe(3);
  });

  it("projects normalized samples proportionally after a resize", () => {
    const history = new EventHistory(10);
    history.add({ x: 256, y: 128, value: 1 }, { width: 512, height: 512 });

    expect(history.project({ width: 1024, height: 1024 })[0]).toEqual({
      x: 512,
      y: 256,
      value: 1,
    });
  });

  it("evicts oldest excess samples when the limit shrinks", () => {
    const history = new EventHistory(5);
    const size = { width: 100, height: 100 };
    for (let x = 1; x <= 5; x++) {
      history.add({ x, y: 50, value: 1 }, size);
    }

    history.setLimit(2);

    expect(history.project(size).map((point) => point.x)).toEqual([4, 5]);
  });

  it("preserves order when a full history grows", () => {
    const history = new EventHistory(3);
    const size = { width: 100, height: 100 };
    for (let x = 1; x <= 4; x++) {
      history.add({ x, y: 50, value: 1 }, size);
    }

    history.setLimit(5);
    history.add({ x: 5, y: 50, value: 1 }, size);

    expect(history.project(size).map((point) => point.x)).toEqual([2, 3, 4, 5]);
  });

  it("clamps edge samples inside normalized coordinates", () => {
    const history = new EventHistory(2);
    history.add({ x: -10, y: 120, value: 1 }, { width: 100, height: 100 });

    expect(history.project({ width: 400, height: 200 })[0]).toEqual({
      x: 0,
      y: 200,
      value: 1,
    });
  });

  it("clears all retained samples", () => {
    const history = new EventHistory(2);
    history.add({ x: 10, y: 10, value: 1 }, { width: 100, height: 100 });
    history.clear();

    expect(history.length).toBe(0);
    expect(history.project({ width: 100, height: 100 })).toEqual([]);
  });
});
