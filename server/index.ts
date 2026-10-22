import { startServer } from "./start";

const { port, hostname, staticDir } = startServer({
	port: Number(process.env.PORT ?? 4317),
	hostname: process.env.HOST ?? "127.0.0.1",
	staticDir: process.env.STATIC_DIR,
	dbPath: process.env.DB_PATH,
});
console.log(`Coding Tokens listening on http://${hostname}:${port}`);
console.log(`Static files: ${staticDir}`);
