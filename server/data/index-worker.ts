import { PricingCatalogManager } from "../../src/pricing/engine";
import { openStoreDatabase } from "./database";
import { type IndexSyncResult, syncHarnessesToDatabase } from "./index-sync";

export interface IndexWorkerRequest {
	dbPath: string;
}

export type IndexWorkerEvent =
	| {
			type: "progress";
			phase: string;
			completed: number;
			total: number;
	  }
	| ({ type: "done" } & IndexSyncResult)
	| {
			type: "error";
			error: string;
	  };

function emitEvent(event: IndexWorkerEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

export async function runIndexSyncWorker(): Promise<void> {
	const raw = await Bun.stdin.text();
	if (!raw.trim()) return;
	const request = JSON.parse(raw) as IndexWorkerRequest;
	const db = openStoreDatabase(request.dbPath);
	try {
		const pricing = new PricingCatalogManager();
		pricing.loadLocalState(db);
		const result = await syncHarnessesToDatabase({
			db,
			catalog: pricing.getCatalog(),
			rules: pricing.getSettings().customRules,
			yieldBetweenSteps: false,
			onProgress: (event) => {
				emitEvent({
					type: "progress",
					phase: event.phase,
					completed: event.completed,
					total: event.total,
				});
			},
		});
		emitEvent({
			type: "done",
			...result,
		});
	} catch (error) {
		emitEvent({
			type: "error",
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		db.close();
	}
}

if (import.meta.main) {
	await runIndexSyncWorker();
}
