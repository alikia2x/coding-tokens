import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "~/components/ui/button";
import { type TranslationKey, useT } from "~/lib/i18n";

export function LoadingScreen({
	phase,
	progress,
	error,
	onRetry,
}: {
	phase: string;
	progress: { completed: number; total: number };
	error?: string | null;
	onRetry?: () => void;
}) {
	const t = useT();
	const phaseKeys: Record<string, TranslationKey> = {
		Starting: "status.starting",
		Indexing: "status.indexing",
		Ready: "status.ready",
		Failed: "status.failed",
	};
	const percent =
		progress.total > 0
			? Math.min(100, Math.round((progress.completed / progress.total) * 100))
			: 0;
	return (
		<div className="flex min-h-screen items-center justify-center bg-background px-6">
			<div className="w-full max-w-sm">
				<div className="font-display mb-5 text-[16px] font-medium tracking-[-0.01em]">
					Coding Tokens
				</div>
				{error ? (
					<>
						<div className="flex items-start gap-2 text-sm">
							<AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
							<div>
								<p className="font-medium">{t("error.localData")}</p>
								<p className="mt-1 break-words text-[12px] text-muted-foreground">
									{error}
								</p>
							</div>
						</div>
						{onRetry ? (
							<Button className="mt-4" size="sm" onClick={onRetry}>
								<RotateCw />
								{t("common.tryAgain")}
							</Button>
						) : null}
					</>
				) : (
					<>
						<div className="flex items-baseline justify-between text-[12px]">
							<span className="text-muted-foreground">
								{t(phaseKeys[phase] ?? "status.ready")}
							</span>
							<span className="text-muted-foreground tabular">
								{progress.completed}/{progress.total}
							</span>
						</div>
						<div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
							<div
								className="h-full bg-foreground transition-[width] duration-300"
								style={{ width: `${Math.max(6, percent)}%` }}
							/>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
