import { type AppSettings, DEFAULT_SETTINGS } from "@shared/types";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useAppSettings, useUpdateAppSettings } from "~/lib/queries";

interface SettingsContextValue {
	settings: AppSettings;
	loaded: boolean;
	settled: boolean;
	saving: boolean;
	update: (partial: Partial<AppSettings>) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({ children }: { children: ReactNode }) {
	const query = useAppSettings();
	const mutation = useUpdateAppSettings();
	const settings = useMemo(
		() => ({ ...DEFAULT_SETTINGS, ...(query.data ?? {}) }),
		[query.data],
	);
	const settled = !query.isPending;
	const value = useMemo(
		() => ({
			settings,
			loaded: query.isSuccess,
			settled,
			saving: mutation.isPending,
			update: (partial: Partial<AppSettings>) => mutation.mutate(partial),
		}),
		[settings, query.isSuccess, settled, mutation],
	);
	return (
		<SettingsContext.Provider value={value}>
			{children}
		</SettingsContext.Provider>
	);
}

export function useSettings(): SettingsContextValue {
	const context = useContext(SettingsContext);
	if (!context)
		throw new Error("useSettings must be used inside SettingsProvider");
	return context;
}
