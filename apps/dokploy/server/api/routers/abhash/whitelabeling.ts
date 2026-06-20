import {
	getWebServerSettings,
	IS_CLOUD,
	updateWebServerSettings,
} from "@dokploy/server";
import { TRPCError } from "@trpc/server";
import { apiUpdateWhitelabeling } from "@/server/db/schema";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
	publicProcedure,
} from "../../trpc";

const emptyWhitelabelingConfig = {
	appName: null,
	appDescription: null,
	logoUrl: null,
	faviconUrl: null,
	customCss: null,
	loginLogoUrl: null,
	supportUrl: null,
	docsUrl: null,
	errorPageTitle: null,
	errorPageDescription: null,
	metaTitle: null,
	footerText: null,
};

const getConfig = async () => {
	if (IS_CLOUD) {
		return null;
	}
	const settings = await getWebServerSettings();
	return settings?.whitelabelingConfig ?? emptyWhitelabelingConfig;
};

export const abhashWhitelabelingRouter = createTRPCRouter({
	get: protectedProcedure.query(getConfig),

	update: adminProcedure
		.input(apiUpdateWhitelabeling)
		.mutation(async ({ input, ctx }) => {
			if (IS_CLOUD) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: "Whitelabeling is only available on self-hosted instances",
				});
			}

			if (ctx.user.role !== "owner") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Only the owner can update whitelabeling settings",
				});
			}

			await updateWebServerSettings({
				whitelabelingConfig: input.whitelabelingConfig,
			});

			return { success: true };
		}),

	reset: adminProcedure.mutation(async ({ ctx }) => {
		if (IS_CLOUD) {
			throw new TRPCError({
				code: "BAD_REQUEST",
				message: "Whitelabeling is only available on self-hosted instances",
			});
		}

		if (ctx.user.role !== "owner") {
			throw new TRPCError({
				code: "FORBIDDEN",
				message: "Only the owner can reset whitelabeling settings",
			});
		}

		await updateWebServerSettings({
			whitelabelingConfig: emptyWhitelabelingConfig,
		});

		return { success: true };
	}),

	getPublic: publicProcedure.query(async () => {
		const config = await getConfig();
		if (!config) return null;

		return {
			appName: config.appName,
			appDescription: config.appDescription,
			logoUrl: config.logoUrl,
			loginLogoUrl: config.loginLogoUrl,
			faviconUrl: config.faviconUrl,
			customCss: config.customCss,
			metaTitle: config.metaTitle,
			errorPageTitle: config.errorPageTitle,
			errorPageDescription: config.errorPageDescription,
			footerText: config.footerText,
		};
	}),
});
