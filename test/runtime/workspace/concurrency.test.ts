import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../../../src/workspace/concurrency";

describe("mapWithConcurrency", () => {
	it("returns an empty array for empty input", async () => {
		const result = await mapWithConcurrency([], 4, async () => 1);
		expect(result).toEqual([]);
	});

	it("preserves input order in results", async () => {
		const items = [10, 20, 30, 40, 50];
		const result = await mapWithConcurrency(items, 2, async (value) => value * 2);
		expect(result).toEqual([20, 40, 60, 80, 100]);
	});

	it("never exceeds the requested concurrency", async () => {
		let active = 0;
		let peak = 0;
		const items = Array.from({ length: 20 }, (_, index) => index);
		await mapWithConcurrency(items, 3, async (value) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active -= 1;
			return value;
		});
		expect(peak).toBeLessThanOrEqual(3);
		expect(peak).toBeGreaterThan(0);
	});

	it("treats a concurrency limit below one as sequential", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrency([1, 2, 3], 0, async (value) => {
			active += 1;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active -= 1;
			return value;
		});
		expect(peak).toBe(1);
	});
});
