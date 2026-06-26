import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

const blankConfig = {
	appName: "",
	appDescription: "",
	logoUrl: "",
	faviconUrl: "",
	customCss: "",
	loginLogoUrl: "",
	supportUrl: "",
	docsUrl: "",
	errorPageTitle: "",
	errorPageDescription: "",
	metaTitle: "",
	footerText: "",
};

type ConfigKey = keyof typeof blankConfig;

const toFormValue = (value: string | null | undefined) => value ?? "";
const toPayloadValue = (value: string) => {
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
};

const textFields: Array<{
	key: ConfigKey;
	label: string;
	placeholder: string;
}> = [
	{ key: "appName", label: "App name", placeholder: "Abhash Dokploy" },
	{
		key: "metaTitle",
		label: "Browser title",
		placeholder: "Abhash Dokploy",
	},
	{
		key: "appDescription",
		label: "App description",
		placeholder: "Personal self-hosted deployment platform",
	},
	{ key: "footerText", label: "Footer text", placeholder: "Built for Abhash" },
];

const urlFields: Array<{ key: ConfigKey; label: string; placeholder: string }> =
	[
		{ key: "logoUrl", label: "Dashboard logo URL", placeholder: "https://..." },
		{
			key: "loginLogoUrl",
			label: "Login logo URL",
			placeholder: "https://...",
		},
		{ key: "faviconUrl", label: "Favicon URL", placeholder: "https://..." },
		{ key: "supportUrl", label: "Support URL", placeholder: "https://..." },
		{ key: "docsUrl", label: "Docs URL", placeholder: "https://..." },
	];

export function AbhashWhitelabelingSettings() {
	const utils = api.useUtils();
	const { data, isLoading } = api.whitelabeling.get.useQuery();
	const update = api.whitelabeling.update.useMutation();
	const reset = api.whitelabeling.reset.useMutation();
	const [form, setForm] = useState(blankConfig);

	useEffect(() => {
		if (!data) return;
		setForm({
			appName: toFormValue(data.appName),
			appDescription: toFormValue(data.appDescription),
			logoUrl: toFormValue(data.logoUrl),
			faviconUrl: toFormValue(data.faviconUrl),
			customCss: toFormValue(data.customCss),
			loginLogoUrl: toFormValue(data.loginLogoUrl),
			supportUrl: toFormValue(data.supportUrl),
			docsUrl: toFormValue(data.docsUrl),
			errorPageTitle: toFormValue(data.errorPageTitle),
			errorPageDescription: toFormValue(data.errorPageDescription),
			metaTitle: toFormValue(data.metaTitle),
			footerText: toFormValue(data.footerText),
		});
	}, [data]);

	const payload = useMemo(
		() => ({
			whitelabelingConfig: {
				appName: toPayloadValue(form.appName),
				appDescription: toPayloadValue(form.appDescription),
				logoUrl: toPayloadValue(form.logoUrl),
				faviconUrl: toPayloadValue(form.faviconUrl),
				customCss: toPayloadValue(form.customCss),
				loginLogoUrl: toPayloadValue(form.loginLogoUrl),
				supportUrl: toPayloadValue(form.supportUrl),
				docsUrl: toPayloadValue(form.docsUrl),
				errorPageTitle: toPayloadValue(form.errorPageTitle),
				errorPageDescription: toPayloadValue(form.errorPageDescription),
				metaTitle: toPayloadValue(form.metaTitle),
				footerText: toPayloadValue(form.footerText),
			},
		}),
		[form],
	);

	const setField = (key: ConfigKey, value: string) => {
		setForm((current) => ({ ...current, [key]: value }));
	};

	const refresh = async () => {
		await Promise.all([
			utils.whitelabeling.get.invalidate(),
			utils.whitelabeling.getPublic.invalidate(),
		]);
	};

	const onSave = async () => {
		try {
			await update.mutateAsync(payload);
			await refresh();
			toast.success("Whitelabeling settings saved");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to save whitelabeling settings",
			);
		}
	};

	const onReset = async () => {
		try {
			await reset.mutateAsync();
			setForm(blankConfig);
			await refresh();
			toast.success("Whitelabeling settings reset");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to reset whitelabeling settings",
			);
		}
	};

	return (
		<div className="space-y-4">
			<CardHeader className="px-0 pt-0">
				<CardTitle className="text-xl">Abhash Whitelabeling</CardTitle>
				<CardDescription>
					Customize the self-hosted dashboard without using Dokploy's
					proprietary whitelabeling UI.
				</CardDescription>
			</CardHeader>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Identity</CardTitle>
					<CardDescription>
						Text shown in the browser, login flow, and footer.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-4 md:grid-cols-2">
					{textFields.map((field) => (
						<div className="space-y-2" key={field.key}>
							<span className="text-sm font-medium">{field.label}</span>
							<Input
								disabled={isLoading}
								placeholder={field.placeholder}
								value={form[field.key]}
								onChange={(event) => setField(field.key, event.target.value)}
							/>
						</div>
					))}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Assets</CardTitle>
					<CardDescription>
						Use absolute HTTP or HTTPS URLs for images and support links.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-4 md:grid-cols-2">
					{urlFields.map((field) => (
						<div className="space-y-2" key={field.key}>
							<span className="text-sm font-medium">{field.label}</span>
							<Input
								disabled={isLoading}
								placeholder={field.placeholder}
								value={form[field.key]}
								onChange={(event) => setField(field.key, event.target.value)}
							/>
						</div>
					))}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Error Page and CSS</CardTitle>
					<CardDescription>
						Override error copy and add a small amount of global dashboard CSS.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="space-y-2 block">
						<span className="text-sm font-medium">Error page title</span>
						<Input
							disabled={isLoading}
							placeholder="Something went wrong"
							value={form.errorPageTitle}
							onChange={(event) =>
								setField("errorPageTitle", event.target.value)
							}
						/>
					</div>
					<div className="space-y-2 block">
						<span className="text-sm font-medium">Error page description</span>
						<Textarea
							disabled={isLoading}
							placeholder="Try again or contact support."
							value={form.errorPageDescription}
							onChange={(event) =>
								setField("errorPageDescription", event.target.value)
							}
						/>
					</div>
					<div className="space-y-2 block">
						<span className="text-sm font-medium">Custom CSS</span>
						<Textarea
							className="min-h-40 font-mono"
							disabled={isLoading}
							placeholder=":root { --sidebar-primary: ... }"
							value={form.customCss}
							onChange={(event) => setField("customCss", event.target.value)}
						/>
					</div>
				</CardContent>
			</Card>

			<div className="flex flex-wrap gap-2">
				<Button isLoading={update.isPending} onClick={onSave}>
					Save Changes
				</Button>
				<Button disabled={reset.isPending} variant="outline" onClick={onReset}>
					Reset
				</Button>
			</div>
		</div>
	);
}
