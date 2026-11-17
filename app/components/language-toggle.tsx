import type { AppLocale } from "@shared/types";
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
import { SUPPORTED_LOCALES, setAppLocale, useT } from "~/lib/i18n";
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
						const locale = value as AppLocale;
						update({ locale });
						setAppLocale(locale);
					}}
				>
					{SUPPORTED_LOCALES.map((item) => (
						<DropdownMenuRadioItem key={item.code} value={item.code}>
							{item.label}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
