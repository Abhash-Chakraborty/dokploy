import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Palette, RotateCcw } from "lucide-react";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { CodeEditor } from "@/components/shared/code-editor";
import { DialogAction } from "@/components/shared/dialog-action";
import { PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

const optionalUrl = z
	.string()
	.trim()
	.refine(
		(value) =>
			value === "" || value.startsWith("/") || /^https?:\/\//.test(value),
		"Use an absolute http(s) URL or a path starting with /",
	);

const schema = z.object({
	appName: z.string().trim().max(60),
	appDescription: z.string().trim().max(300),
	logoUrl: optionalUrl,
	loginLogoUrl: optionalUrl,
	faviconUrl: optionalUrl,
	ogImageUrl: optionalUrl,
	supportUrl: optionalUrl,
	docsUrl: optionalUrl,
	errorPageTitle: z.string().trim().max(120),
	errorPageDescription: z.string().trim().max(500),
	footerText: z.string().trim().max(200),
	customCss: z.string(),
});

type FormValues = z.infer<typeof schema>;
type Field = keyof FormValues;

const EMPTY: FormValues = {
	appName: "",
	appDescription: "",
	logoUrl: "",
	loginLogoUrl: "",
	faviconUrl: "",
	ogImageUrl: "",
	supportUrl: "",
	docsUrl: "",
	errorPageTitle: "",
	errorPageDescription: "",
	footerText: "",
	customCss: "",
};

const SECTIONS: {
	title: string;
	description: string;
	fields: { name: Field; label: string; placeholder?: string; hint?: string }[];
}[] = [
	{
		title: "Identity",
		description: "Name and description shown in the browser and link previews.",
		fields: [
			{ name: "appName", label: "App name", placeholder: "Dokploy" },
			{
				name: "appDescription",
				label: "Description",
				placeholder: "Deployments for the platform team",
			},
		],
	},
	{
		title: "Images",
		description: "Absolute URLs, or paths served from this instance.",
		fields: [
			{
				name: "logoUrl",
				label: "Sidebar logo",
				placeholder: "https://…/logo.svg",
			},
			{
				name: "loginLogoUrl",
				label: "Sign-in logo",
				placeholder: "https://…/logo-large.svg",
			},
			{
				name: "faviconUrl",
				label: "Favicon",
				placeholder: "https://…/favicon.ico",
			},
			{
				name: "ogImageUrl",
				label: "Link preview image",
				placeholder: "https://…/og.png",
				hint: "Shown when the instance URL is shared (1200×630).",
			},
		],
	},
	{
		title: "Help links",
		description: "Where the Docs and Support entries in the user menu point.",
		fields: [
			{ name: "docsUrl", label: "Documentation URL" },
			{ name: "supportUrl", label: "Support URL" },
		],
	},
	{
		title: "Error page and footer",
		description: "Text for the error page and the dashboard footer.",
		fields: [
			{ name: "errorPageTitle", label: "Error page title" },
			{ name: "errorPageDescription", label: "Error page description" },
			{ name: "footerText", label: "Footer text" },
		],
	},
];

const toConfig = (values: FormValues) =>
	Object.fromEntries(
		Object.entries(values).map(([key, value]) => [
			key,
			value.trim() === "" ? null : value,
		]),
	) as { [K in Field]: string | null };

export const WhitelabelingForm = () => {
	const utils = api.useUtils();
	const { data, isLoading } = api.whitelabeling.get.useQuery();
	const { mutateAsync: update, isPending: isSaving } =
		api.whitelabeling.update.useMutation();
	const { mutateAsync: reset, isPending: isResetting } =
		api.whitelabeling.reset.useMutation();

	const form = useForm<FormValues>({
		defaultValues: EMPTY,
		resolver: zodResolver(schema),
	});

	useEffect(() => {
		if (!data) return;
		form.reset(
			Object.fromEntries(
				Object.keys(EMPTY).map((key) => [
					key,
					(data as Record<string, string | null>)[key] ?? "",
				]),
			) as FormValues,
		);
	}, [data, form]);

	const onSubmit = async (values: FormValues) => {
		await update({ whitelabelingConfig: toConfig(values) })
			.then(async () => {
				await utils.whitelabeling.invalidate();
				toast.success("Branding saved");
			})
			.catch((error: Error) => toast.error(error.message));
	};

	return (
		<>
			<PageHeader
				title="Whitelabeling"
				description="Rebrand the dashboard, sign-in page and link previews."
				icon={<Palette className="size-5" />}
				actions={
					<DialogAction
						title="Reset branding?"
						description="All branding fields return to the Dokploy defaults."
						type="destructive"
						onClick={async () => {
							await reset()
								.then(async () => {
									await utils.whitelabeling.invalidate();
									form.reset(EMPTY);
									toast.success("Branding reset");
								})
								.catch((error: Error) => toast.error(error.message));
						}}
					>
						<Button variant="outline" isLoading={isResetting}>
							<RotateCcw className="size-4" />
							Reset
						</Button>
					</DialogAction>
				}
			/>
			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="flex flex-col gap-8"
				>
					{SECTIONS.map((section) => (
						<section
							key={section.title}
							className="grid gap-4 border-b pb-8 md:grid-cols-[16rem_1fr]"
						>
							<div>
								<h3 className="text-sm font-medium">{section.title}</h3>
								<p className="text-sm text-muted-foreground">
									{section.description}
								</p>
							</div>
							<div className="grid gap-4 md:grid-cols-2">
								{section.fields.map((field) => (
									<FormField
										key={field.name}
										control={form.control}
										name={field.name}
										render={({ field: input }) => (
											<FormItem>
												<FormLabel>{field.label}</FormLabel>
												<FormControl>
													{field.name === "errorPageDescription" ||
													field.name === "appDescription" ? (
														<Textarea
															{...input}
															placeholder={field.placeholder}
															disabled={isLoading}
														/>
													) : (
														<Input
															{...input}
															placeholder={field.placeholder}
															disabled={isLoading}
														/>
													)}
												</FormControl>
												{field.hint && (
													<FormDescription>{field.hint}</FormDescription>
												)}
												<FormMessage />
											</FormItem>
										)}
									/>
								))}
							</div>
						</section>
					))}

					<section className="grid gap-4 md:grid-cols-[16rem_1fr]">
						<div>
							<h3 className="text-sm font-medium">Custom CSS</h3>
							<p className="text-sm text-muted-foreground">
								Injected on every page, including sign-in.
							</p>
						</div>
						<FormField
							control={form.control}
							name="customCss"
							render={({ field }) => (
								<FormItem>
									<FormControl>
										<CodeEditor
											language="css"
											value={field.value}
											onChange={field.onChange}
											className="h-64 font-mono"
											placeholder=":root { --primary: 221 83% 53%; }"
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</section>

					<div className="flex justify-end">
						<Button type="submit" isLoading={isSaving} disabled={isLoading}>
							Save branding
						</Button>
					</div>
				</form>
			</Form>
		</>
	);
};
