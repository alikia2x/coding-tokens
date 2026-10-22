import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";

export type ThemeMode = "light" | "dark" | "system";

interface ThemeContextValue {
	mode: ThemeMode;
	resolved: "light" | "dark";
	setMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const storageKey = "coding-tokens-theme";

function systemDark(): boolean {
	return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function readStoredMode(): ThemeMode {
	try {
		const value = localStorage.getItem(storageKey);
		if (value === "light" || value === "dark" || value === "system")
			return value;
	} catch {}
	return "system";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
	const [mode, setModeState] = useState<ThemeMode>(() => readStoredMode());
	const [dark, setDark] = useState(
		() => mode === "dark" || (mode === "system" && systemDark()),
	);

	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const apply = () => {
			const nextDark = mode === "dark" || (mode === "system" && media.matches);
			setDark(nextDark);
			document.documentElement.classList.toggle("dark", nextDark);
			document.documentElement.style.colorScheme = nextDark ? "dark" : "light";
			document
				.querySelector('meta[name="theme-color"]')
				?.setAttribute("content", nextDark ? "#141310" : "#f6f5f2");
		};
		apply();
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [mode]);

	const setMode = useCallback((next: ThemeMode): void => {
		setModeState(next);
		try {
			localStorage.setItem(storageKey, next);
		} catch {}
	}, []);

	const value = useMemo(
		() => ({
			mode,
			resolved: dark ? ("dark" as const) : ("light" as const),
			setMode,
		}),
		[mode, dark, setMode],
	);
	return (
		<ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
	);
}

export function useTheme(): ThemeContextValue {
	const context = useContext(ThemeContext);
	if (!context) throw new Error("useTheme must be used inside ThemeProvider");
	return context;
}
