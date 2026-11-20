import path from "node:path";
import { app, BrowserWindow, Utils } from "electrobun/main";
import {
	type ApplicationMenuItemConfig,
	setApplicationMenu,
} from "electrobun/main/app-menu";
import { VIEWS_FOLDER } from "electrobun/main/paths";
import { store } from "../server/data/store";
import { startServer } from "../server/start";
import { defaultPlatformPathService } from "../src/platform/paths";

const isMac = process.platform === "darwin";
const cmdOrCtrl = isMac ? "Command" : "Control";

const appSubmenu: ApplicationMenuItemConfig[] = [
	{ role: "about" },
	{ type: "divider" },
];
if (isMac) {
	appSubmenu.push(
		{ role: "hide", accelerator: "Command+H" },
		{ role: "hideOthers", accelerator: "Command+Alt+H" },
		{ role: "showAll" },
		{ type: "divider" },
	);
}
appSubmenu.push({
	role: "quit",
	accelerator: isMac ? "Command+Q" : "Control+Q",
});

if (isMac) {
	setApplicationMenu([
		{
			label: "Coding Tokens",
			submenu: appSubmenu,
		},
		{
			label: "Edit",
			submenu: [
				{ role: "undo", accelerator: `${cmdOrCtrl}+Z` },
				{ role: "redo", accelerator: `${cmdOrCtrl}+Shift+Z` },
				{ type: "divider" },
				{ role: "cut", accelerator: `${cmdOrCtrl}+X` },
				{ role: "copy", accelerator: `${cmdOrCtrl}+C` },
				{ role: "paste", accelerator: `${cmdOrCtrl}+V` },
				{ role: "pasteAndMatchStyle", accelerator: `${cmdOrCtrl}+Shift+V` },
				{ role: "delete" },
				{ type: "divider" },
				{ role: "selectAll", accelerator: `${cmdOrCtrl}+A` },
			],
		},
		{
			label: "Window",
			submenu: [
				{ role: "minimize", accelerator: `${cmdOrCtrl}+M` },
				{ role: "zoom" },
				{ role: "close", accelerator: `${cmdOrCtrl}+W` },
				{ type: "divider" },
				{ role: "bringAllToFront" },
			],
		},
	]);
}

const staticDir = path.join(VIEWS_FOLDER, "mainview");
const userDataDir =
	Utils?.paths?.userData ??
	defaultPlatformPathService.getDataDir("coding-tokens");
const databasePath = path.join(userDataDir, "coding-tokens.sqlite");
const { server, port } = startServer({
	port: 0,
	hostname: "127.0.0.1",
	staticDir,
	dbPath: databasePath,
	desktopPlatform: process.platform,
	deferStartMs: 250,
	useIndexWorker: true,
	pickDirectory: async () => {
		const selected = await Utils.openFileDialog({
			startingFolder: "",
			canChooseFiles: false,
			canChooseDirectory: true,
			allowsMultipleSelection: false,
		});
		return selected[0] ?? null;
	},
	revealPath: (targetPath: string) => {
		Utils.showItemInFolder(targetPath);
	},
});

const mainWindow = new BrowserWindow({
	title: "Coding Tokens",
	url: `http://127.0.0.1:${port}`,
	frame: {
		width: 1360,
		height: 900,
	},
	titleBarStyle: isMac ? "hiddenInset" : "default",
	trafficLightOffset: isMac ? { x: 16, y: 15 } : undefined,
});

let serverStopped = false;
const stopDesktopServer = () => {
	if (serverStopped) return;
	serverStopped = true;
	try {
		server.stop();
	} catch {}
	try {
		store.close();
	} catch {}
};

app.on("before-quit", stopDesktopServer);
mainWindow.on("close", stopDesktopServer);
process.on("SIGINT", stopDesktopServer);
process.on("SIGTERM", stopDesktopServer);

console.log(`Coding Tokens window: http://127.0.0.1:${port}`);
console.log(`Views: ${staticDir}`);
console.log(`Database: ${databasePath}`);
console.log(`Window: ${mainWindow.id}`);
