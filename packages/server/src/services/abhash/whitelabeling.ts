import { IS_CLOUD } from "../../constants";
import { getWebServerSettings } from "../web-server-settings";

/**
 * Branding for pages rendered without a session (login, error pages and the
 * SSR document shell). This fork enables whitelabeling without a license, so
 * unlike upstream's variant it does not check one.
 */
export const getAbhashPublicWhitelabelingConfig = async () => {
	if (IS_CLOUD) return null;

	const config = (await getWebServerSettings())?.whitelabelingConfig;
	if (!config) return null;

	const {
		appName,
		appDescription,
		logoUrl,
		loginLogoUrl,
		faviconUrl,
		customCss,
		ogImageUrl,
		errorPageTitle,
		errorPageDescription,
		footerText,
	} = config;
	return {
		appName,
		appDescription,
		logoUrl,
		loginLogoUrl,
		faviconUrl,
		customCss,
		ogImageUrl,
		errorPageTitle,
		errorPageDescription,
		footerText,
	};
};
