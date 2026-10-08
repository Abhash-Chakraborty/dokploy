import "@/styles/globals.css";

import type { NextPage } from "next";
import type { AppProps } from "next/app";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
import NextTopLoader from "nextjs-toploader";
import type { ReactElement, ReactNode } from "react";
import { SearchCommand } from "@/components/dashboard/search-command";
import { Analytics } from "@/components/shared/analytics";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { api } from "@/utils/api";

const geist = Geist({ subsets: ["latin"] });
const geistMono = Geist_Mono({ subsets: ["latin"] });

export type NextPageWithLayout<P = {}, IP = P> = NextPage<P, IP> & {
	getLayout?: (page: ReactElement) => ReactNode;
	theme?: string;
};

type AppPropsWithLayout = AppProps & {
	Component: NextPageWithLayout;
};

const MyApp = ({
	Component,
	pageProps: { ...pageProps },
}: AppPropsWithLayout) => {
	const getLayout = Component.getLayout ?? ((page) => page);

	return (
		<>
			<style
				// Plain style tag: Turbopack does not bundle styled-jsx.
				// biome-ignore lint/security/noDangerouslySetInnerHtml: static font variables
				dangerouslySetInnerHTML={{
					__html: `:root{--font-inter:${geist.style.fontFamily};--font-geist-mono:${geistMono.style.fontFamily};}`,
				}}
			/>
			<TooltipProvider>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					enableSystem
					disableTransitionOnChange
					forcedTheme={Component.theme}
				>
					<NextTopLoader color="hsl(var(--sidebar-ring))" />
					<Analytics />
					<Toaster richColors />
					<SearchCommand />
					{getLayout(<Component {...pageProps} />)}
				</ThemeProvider>
			</TooltipProvider>
		</>
	);
};

export default api.withTRPC(MyApp);
