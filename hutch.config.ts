// @hutch cli=0.28.1 cottontail=0.7.2
export default {
	scripts: {
		install: ["bun", "install"],
		dev: ["bun", "run", "dev:app"],
		build: ["bun", "run", "build:app"],
	},
	electrobun: {
		version: "2.0.4",
	},
};
