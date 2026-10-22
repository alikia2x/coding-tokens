import path from "node:path";

const root = path.join(import.meta.dir, "..");
const bun = process.execPath;
const api = Bun.spawn([bun, "run", path.join(root, "server/index.ts")], {
	cwd: root,
	env: { ...process.env, PORT: process.env.PORT ?? "4317" },
	stdio: ["inherit", "inherit", "inherit"],
});
const vite = Bun.spawn(
	[bun, path.join(root, "node_modules/vite/bin/vite.js")],
	{
		cwd: root,
		env: { ...process.env, PORT: process.env.PORT ?? "4317" },
		stdio: ["inherit", "inherit", "inherit"],
	},
);

function shutdown(): void {
	try {
		api.kill();
	} catch {}
	try {
		vite.kill();
	} catch {}
	process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const code = await Promise.race([api.exited, vite.exited]);
shutdown();
process.exitCode = code;
