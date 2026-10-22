import path from "node:path";
import { BrowserWindow, Utils } from "electrobun/main";
import { setApplicationMenu } from "electrobun/main/app-menu";
import { VIEWS_FOLDER } from "electrobun/main/paths";
import { startServer } from "../server/start";

setApplicationMenu([
	{
		label: "Coding Tokens",
		submenu: [
			{ role: "about" },
			{ type: "divider" },
			{ role: "hide", accelerator: "Command+H" },
			{ role: "hideOthers", accelerator: "Command+Alt+H" },
			{ role: "showAll" },
			{ type: "divider" },
			{ role: "quit", accelerator: "Command+Q" },
		],
	},
	{
		label: "Edit",
		submenu: [
			{ role: "undo", accelerator: "Command+Z" },
			{ role: "redo", accelerator: "Command+Shift+Z" },
			{ type: "divider" },
			{ role: "cut", accelerator: "Command+X" },
			{ role: "copy", accelerator: "Command+C" },
			{ role: "paste", accelerator: "Command+V" },
			{ role: "pasteAndMatchStyle", accelerator: "Command+Shift+V" },
			{ role: "delete" },
			{ type: "divider" },
			{ role: "selectAll", accelerator: "Command+A" },
		],
	},
	{
		label: "Window",
		submenu: [
			{ role: "minimize", accelerator: "Command+M" },
			{ role: "zoom" },
			{ role: "close", accelerator: "Command+W" },
			{ type: "divider" },
			{ role: "bringAllToFront" },
		],
	},
]);

const staticDir = path.join(VIEWS_FOLDER, "mainview");
const databasePath = path.join(Utils.paths.userData, "coding-tokens.sqlite");
const { port } = startServer({
	port: 0,
	hostname: "127.0.0.1",
	staticDir,
	dbPath: databasePath,
});

const mainWindow = new BrowserWindow({
	title: "Coding Tokens",
	url: `http://127.0.0.1:${port}`,
	frame: {
		width: 1360,
		height: 900,
	},
	titleBarStyle: "hiddenInset",
	trafficLightOffset: { x: 16, y: 15 },
});

console.log(`Coding Tokens window: http://127.0.0.1:${port}`);
console.log(`Views: ${staticDir}`);
console.log(`Database: ${databasePath}`);
console.log(`Window: ${mainWindow.id}`);
