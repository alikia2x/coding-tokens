import type { TranslationKey } from "./i18n";

const placeholderKeys: Record<string, TranslationKey> = {
	"Untitled session": "session.untitled",
	"Unknown project": "projects.unknown",
	"Unknown model": "models.unknown",
	"Unrecorded model": "models.unknown",
	All: "common.all",
	Other: "common.other",
};

type Translate = (
	key: TranslationKey,
	options?: Record<string, unknown>,
) => string;

export function localizeLabel(
	t: Translate,
	value: string | null | undefined,
	fallback = "—",
): string {
	if (!value) return fallback;
	const key = placeholderKeys[value];
	return key ? t(key) : value;
}
