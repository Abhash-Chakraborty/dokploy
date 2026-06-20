import { useEffect } from "react";
import { api } from "@/utils/api";

export function WhitelabelingProvider() {
	const { data } = api.whitelabeling.getPublic.useQuery(undefined, {
		retry: false,
		refetchOnWindowFocus: false,
	});

	useEffect(() => {
		if (!data) return;

		const title = data.metaTitle || data.appName || "Dokploy";
		document.title = title;

		if (data.faviconUrl) {
			let favicon = document.querySelector<HTMLLinkElement>("link[rel='icon']");
			if (!favicon) {
				favicon = document.createElement("link");
				favicon.rel = "icon";
				document.head.appendChild(favicon);
			}
			favicon.href = data.faviconUrl;
		}

		let style = document.getElementById("abhash-whitelabeling-css");
		if (data.customCss) {
			if (!style) {
				style = document.createElement("style");
				style.id = "abhash-whitelabeling-css";
				document.head.appendChild(style);
			}
			style.textContent = data.customCss;
		} else {
			style?.remove();
		}
	}, [data]);

	return null;
}
