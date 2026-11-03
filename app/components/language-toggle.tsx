import { Globe } from "lucide-react";
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
import { setAppLocale, useT } from "~/lib/i18n";
import { useSettings } from "~/lib/settings";

export function LanguageToggle() {
	const { settings, update } = useSettings();
	const t = useT();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={t("settings.language")}
				>
					<Globe />
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-44">
				<DropdownMenuLabel>{t("settings.language")}</DropdownMenuLabel>
				<DropdownMenuSeparator />
				<DropdownMenuRadioGroup
					value={settings.locale}
					onValueChange={(value) => {
						update({ locale: value as "en" | "zh-CN" });
						setAppLocale(value as "en" | "zh-CN");
					}}
				>
					<DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
					<DropdownMenuRadioItem value="zh-CN">简体中文</DropdownMenuRadioItem>
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
