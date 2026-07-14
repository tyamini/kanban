/**
 * Run `mapper` over `items` with a bounded number of concurrent executions.
 *
 * This exists because fanning out one async task per item with
 * `Promise.all(items.map(...))` is unbounded: for git-backed work that spawns a
 * child process per item, a large input (e.g. a huge diff) can spawn thousands
 * of processes at once, starve the libuv thread pool, block the event loop
 * (so finished children are never reaped) and leak their stdio handles. Capping
 * concurrency keeps the runtime responsive regardless of input size.
 *
 * Results are returned in the same order as `items`.
 */
export async function mapWithConcurrency<T, R>(
	items: readonly T[],
	concurrencyLimit: number,
	mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	if (items.length === 0) {
		return [];
	}
	const workerCount = Math.max(1, Math.min(concurrencyLimit, items.length));
	const results = new Array<R>(items.length);
	let nextIndex = 0;

	async function runWorker(): Promise<void> {
		while (true) {
			const currentIndex = nextIndex;
			nextIndex += 1;
			if (currentIndex >= items.length) {
				return;
			}
			results[currentIndex] = await mapper(items[currentIndex] as T, currentIndex);
		}
	}

	const workers: Promise<void>[] = [];
	for (let index = 0; index < workerCount; index += 1) {
		workers.push(runWorker());
	}
	await Promise.all(workers);
	return results;
}
