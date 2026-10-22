import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "~/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { type TranslationKey, useT } from "~/lib/i18n";
import { type ThemeMode, useTheme } from "~/lib/theme";

const modes: Array<{
	value: ThemeMode;
	label: TranslationKey;
	icon: typeof Sun;
}> = [
	{ value: "light", label: "theme.light", icon: Sun },
	{ value: "dark", label: "theme.dark", icon: Moon },
	{ value: "system", label: "theme.system", icon: Monitor },
];

export function ThemeToggle() {
	const { mode, resolved, setMode } = useTheme();
	const t = useT();
	const Icon = resolved === "dark" ? Moon : Sun;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button variant="ghost" size="icon-sm" aria-label={t("app.colorTheme")}>
					<Icon />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-40">
				<DropdownMenuLabel>{t("settings.theme")}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					value={mode}
					onValueChange={(value) => setMode(value as ThemeMode)}
				>
					{modes.map((item) => (
						<DropdownMenuRadioItem key={item.value} value={item.value}>
							<item.icon className="size-4" />
							{t(item.label)}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
