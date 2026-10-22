import type { TranslationKey } from "./i18n";

const placeholderKeys: Record<string, TranslationKey> = {
	"Untitled session": "session.untitled",
	"Unknown project": "projects.unknown",
	"Unknown model": "models.unknown",
	"Unrecorded Model": "models.unknown",
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
