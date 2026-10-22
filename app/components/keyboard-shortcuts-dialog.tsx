import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "~/components/ui/dialog";
import { useT } from "~/lib/i18n";
import { shortcuts } from "~/lib/use-app-shortcuts";

export function KeyboardShortcutsDialog({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("shortcuts.title")}</DialogTitle>
					<DialogDescription>
						{t("shortcuts.editingDescription")}
					</DialogDescription>
				</DialogHeader>
				<div className="divide-y">
					{shortcuts.map((shortcut) => (
						<div
							key={shortcut.keys}
							className="flex items-center justify-between py-2 text-[12px]"
						>
							<span className="text-muted-foreground">{t(shortcut.label)}</span>
							<kbd className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px]">
								{shortcut.keys}
							</kbd>
						</div>
					))}
					<div className="flex items-center justify-between py-2 text-[12px]">
						<span className="text-muted-foreground">
							{t("shortcuts.editing")}
						</span>
						<kbd className="rounded border bg-surface px-1.5 py-0.5 font-mono text-[10px]">
							⌘ C / V / X / A
						</kbd>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
