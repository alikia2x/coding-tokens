const worker = process.env.CODING_TOKENS_WORKER;

if (worker === "batch-export") {
	const { runBatchExportWorker } = await import("../server/data/export-worker");
	await runBatchExportWorker();
	process.exit(0);
}

if (worker === "index-sync") {
	const { runIndexSyncWorker } = await import("../server/data/index-worker");
	await runIndexSyncWorker();
	process.exit(0);
}

await import("./app");

export {};
