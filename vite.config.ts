import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		alias: {
			"~": fileURLToPath(new URL("./app", import.meta.url)),
			"@shared": fileURLToPath(new URL("./shared", import.meta.url)),
		},
	},
	build: {
		outDir: "dist",
		emptyOutDir: true,
		sourcemap: false,
	},
	server: {
		port: 5173,
		proxy: {
			"/api": "http://127.0.0.1:4317",
		},
	},
});
