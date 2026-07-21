import { describe, expect, it } from "vitest";
import { TrailBuffer } from "./_trail";

const pt = (x: number) => ({ x, y: 0, value: 20 });

describe("TrailBuffer", () => {
  it("keeps at most maxLength most-recent points", () => {
    const buf = new TrailBuffer(3);
    for (let i = 0; i < 10; i++) buf.push(pt(i));
    expect(buf.length).toBe(3);
    expect(buf.snapshot().map((p) => p.x)).toEqual([7, 8, 9]);
  });

  it("setCapacity trims immediately when shrinking", () => {
    const buf = new TrailBuffer(100);
    for (let i = 0; i < 100; i++) buf.push(pt(i));
    buf.setCapacity(5);
    expect(buf.length).toBe(5);
    expect(buf.snapshot().map((p) => p.x)).toEqual([95, 96, 97, 98, 99]);
  });

  it("setCapacity grows the window without dropping existing points", () => {
    const buf = new TrailBuffer(3);
    for (let i = 0; i < 3; i++) buf.push(pt(i));
    buf.setCapacity(10);
    expect(buf.length).toBe(3);
    for (let i = 3; i < 10; i++) buf.push(pt(i));
    expect(buf.length).toBe(10); // fills up to the new capacity
  });

  it("setCapacity floors to at least 1 and coerces fractionals", () => {
    const buf = new TrailBuffer(5);
    for (let i = 0; i < 5; i++) buf.push(pt(i));
    buf.setCapacity(2.9);
    expect(buf.length).toBe(2); // floored to 2
    buf.setCapacity(0);
    expect(buf.length).toBe(1); // clamped to >= 1
  });
});
