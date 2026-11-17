import { existsSync } from "node:fs";
import path from "node:path";
import { handleApi } from "./api";
import { store } from "./data/store";

export interface StartServerOptions {
	port?: number;
	hostname?: string;
	staticDir?: string;
	development?: boolean;
	dbPath?: string;
	desktopPlatform?: string;
}

const contentTypes: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".woff2": "font/woff2",
	".ico": "image/x-icon",
};

function safeFile(staticDir: string, pathname: string): string | null {
	if (pathname === "/" || pathname === "")
		return path.join(staticDir, "index.html");
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return null;
	}
	const resolved = path.resolve(staticDir, `.${decoded}`);
	if (!resolved.startsWith(`${path.resolve(staticDir)}${path.sep}`))
		return null;
	return resolved;
}

async function serveStatic(
	request: Request,
	url: URL,
	staticDir: string,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD")
		return new Response("Method not allowed", { status: 405 });
	const filePath = safeFile(staticDir, url.pathname);
	const fallback = path.join(staticDir, "index.html");
	if (!existsSync(fallback)) {
		return new Response(
			"Coding Tokens is not built yet. Run `bun run build` and start the server again.",
			{ status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
		);
	}
	if (!filePath || !existsSync(filePath)) {
		if (path.extname(url.pathname))
			return new Response("Not found", { status: 404 });
		const index = Bun.file(fallback);
		return new Response(request.method === "HEAD" ? null : index, {
			headers: {
				"Content-Type": contentTypes[".html"] as string,
				"Cache-Control": "no-cache",
			},
		});
	}
	const isHashedAsset = url.pathname.startsWith("/assets/");
	const file = Bun.file(filePath);
	return new Response(request.method === "HEAD" ? null : file, {
		headers: {
			"Content-Type":
				contentTypes[path.extname(filePath)] ?? "application/octet-stream",
			"Cache-Control": isHashedAsset
				? "public, max-age=31536000, immutable"
				: "no-cache",
		},
	});
}

export function startServer(options: StartServerOptions = {}) {
	const port = options.port ?? 4317;
	const hostname = options.hostname ?? "127.0.0.1";
	const staticDir =
		options.staticDir ?? path.join(import.meta.dir, "..", "dist");
	store.configure({
		dbPath: options.dbPath,
		desktopPlatform: options.desktopPlatform,
	});
	void store.start();
	const server = Bun.serve({
		port,
		hostname,
		development: options.development ?? process.env.NODE_ENV !== "production",
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
				return handleApi(request, url);
			}
			return serveStatic(request, url, staticDir);
		},
		error(error) {
			console.error(error);
			return new Response(JSON.stringify({ error: "Internal server error" }), {
				status: 500,
				headers: { "Content-Type": "application/json; charset=utf-8" },
			});
		},
	});
	return { server, port: server.port, hostname, staticDir };
}
