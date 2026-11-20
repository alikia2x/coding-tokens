const worker = process.env.CODING_TOKENS_WORKER;

if (worker === "batch-export") {
	const { runBatchExportWorker } = await import("./data/export-worker");
	await runBatchExportWorker();
	process.exit(0);
}

if (worker === "index-sync") {
	const { runIndexSyncWorker } = await import("./data/index-worker");
	await runIndexSyncWorker();
	process.exit(0);
}

const { startServer } = await import("./start");
const { store } = await import("./data/store");

const { server, port, hostname, staticDir } = startServer({
	port: Number(process.env.PORT ?? 4317),
	hostname: process.env.HOST ?? "127.0.0.1",
	staticDir: process.env.STATIC_DIR,
	dbPath: process.env.DB_PATH,
	deferStartMs: 100,
	useIndexWorker: true,
});

const shutdown = () => {
	try {
		server.stop();
	} catch {}
	try {
		store.close();
	} catch {}
	process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

console.log(`Coding Tokens listening on http://${hostname}:${port}`);
console.log(`Static files: ${staticDir}`);

export {};
