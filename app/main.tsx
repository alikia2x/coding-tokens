import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "~/styles/app.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { App } from "~/app";
import { TooltipProvider } from "~/components/ui/tooltip";
import { RangeProvider } from "~/lib/range";
import { SettingsProvider } from "~/lib/settings";
import { ThemeProvider } from "~/lib/theme";
import "~/lib/i18n";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			retry: 1,
			refetchOnWindowFocus: false,
			staleTime: 30_000,
		},
	},
});

createRoot(document.getElementById("root") as HTMLElement).render(
	<StrictMode>
		<QueryClientProvider client={queryClient}>
			<SettingsProvider>
				<ThemeProvider>
					<TooltipProvider delayDuration={250}>
						<BrowserRouter>
							<RangeProvider>
								<App />
							</RangeProvider>
						</BrowserRouter>
					</TooltipProvider>
				</ThemeProvider>
			</SettingsProvider>
		</QueryClientProvider>
	</StrictMode>,
);
