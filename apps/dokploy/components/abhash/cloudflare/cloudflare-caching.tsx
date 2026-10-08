import { ChevronDown, Pencil, Plus, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { SectionHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";

type Rule = RouterOutputs["cloudflareCache"]["rules"]["owned"][number];
type RuleDraft = Omit<Rule, "id"> & { id?: string };

interface Props {
	dnsProviderId: string;
	zoneId: string;
	zoneName: string;
}

// The TTLs Cloudflare accepts for browser_cache_ttl; 0 keeps the origin's headers.
const BROWSER_TTLS: [number, string][] = [
	[0, "Respect origin headers"],
	[1800, "30 minutes"],
	[3600, "1 hour"],
	[14400, "4 hours"],
	[86400, "1 day"],
	[604800, "1 week"],
	[2678400, "1 month"],
	[31536000, "1 year"],
];

const RULE_TTLS: [number | null, string][] = [
	[null, "Respect origin headers"],
	[60, "1 minute"],
	[600, "10 minutes"],
	[3600, "1 hour"],
	[7200, "2 hours"],
	[86400, "1 day"],
	[604800, "1 week"],
	[2592000, "30 days"],
	[31536000, "1 year"],
];

const ttlLabel = (seconds: number | null) =>
	RULE_TTLS.find(([value]) => value === seconds)?.[1] ?? `${seconds} seconds`;

const STATIC_EXTENSIONS =
	"js css mjs map png jpg jpeg gif webp avif svg ico woff woff2 ttf otf".split(
		" ",
	);

const presets = (zoneName: string): { label: string; rule: RuleDraft }[] => [
	{
		label: "Static files",
		rule: {
			name: "Static files",
			hosts: [],
			pathPrefix: "",
			extensions: STATIC_EXTENSIONS,
			mode: "cache",
			edgeTtl: 2592000,
			browserTtl: null,
			enabled: true,
		},
	},
	{
		label: "Next.js build output",
		rule: {
			name: "Next.js build output",
			hosts: [],
			pathPrefix: "/_next/static/",
			extensions: [],
			mode: "cache",
			edgeTtl: 31536000,
			browserTtl: 31536000,
			enabled: true,
		},
	},
	{
		label: "Cache a whole site",
		rule: {
			name: "Whole site",
			hosts: [zoneName],
			pathPrefix: "",
			extensions: [],
			mode: "cache",
			edgeTtl: 7200,
			browserTtl: null,
			enabled: true,
		},
	},
	{
		label: "Never cache a path",
		rule: {
			name: "Never cache the API",
			hosts: [],
			pathPrefix: "/api/",
			extensions: [],
			mode: "bypass",
			edgeTtl: null,
			browserTtl: null,
			enabled: true,
		},
	},
];

const describeMatch = (rule: Rule) => {
	const parts = [
		rule.hosts.length ? rule.hosts.join(", ") : "every hostname",
		rule.pathPrefix ? `paths under ${rule.pathPrefix}` : null,
		rule.extensions.length ? `.${rule.extensions.join(" .")}` : null,
	].filter(Boolean);
	return parts.join(" · ");
};

const describeAction = (rule: Rule) =>
	rule.mode === "bypass"
		? "Never cached"
		: `Edge ${ttlLabel(rule.edgeTtl).toLowerCase()} · browser ${ttlLabel(rule.browserTtl).toLowerCase()}`;

const SettingRow = ({
	title,
	description,
	children,
}: {
	title: string;
	description: ReactNode;
	children: ReactNode;
}) => (
	<div className="flex items-center justify-between gap-6 py-3">
		<div className="min-w-0">
			<p className="text-sm font-medium">{title}</p>
			<p className="text-[13px] text-muted-foreground">{description}</p>
		</div>
		<div className="shrink-0">{children}</div>
	</div>
);

export const CloudflareCaching = ({
	dnsProviderId,
	zoneId,
	zoneName,
}: Props) => {
	const zone = { dnsProviderId, zoneId };
	const utils = api.useUtils();
	const { data: permissions } = api.user.getPermissions.useQuery();
	const canEdit = !!permissions?.dnsProvider.update;
	const settings = api.cloudflareCache.settings.useQuery(zone, {
		retry: false,
	});
	const rules = api.cloudflareCache.rules.useQuery(zone, { retry: false });
	const updateSetting = api.cloudflareCache.updateSetting.useMutation();
	const setTiered = api.cloudflareCache.setTieredCache.useMutation();
	const deleteRule = api.cloudflareCache.deleteRule.useMutation();
	const saveRule = api.cloudflareCache.saveRule.useMutation();
	const purge = api.cloudflareCache.purge.useMutation();
	const [editing, setEditing] = useState<RuleDraft | null>(null);
	const [purgeKind, setPurgeKind] = useState<"files" | "hosts" | "prefixes">(
		"files",
	);
	const [purgeValues, setPurgeValues] = useState("");

	const values = settings.data?.settings;
	const change = async (
		id: Parameters<typeof updateSetting.mutateAsync>[0]["id"],
		value: string | number,
	) => {
		try {
			await updateSetting.mutateAsync({ ...zone, id, value });
			await utils.cloudflareCache.settings.invalidate(zone);
			toast.success("Saved to Cloudflare");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not save");
		}
	};
	const toggle = (id: Parameters<typeof change>[0]) => (
		<Switch
			checked={values?.[id]?.value === "on"}
			disabled={!canEdit || values?.[id]?.editable === false}
			onCheckedChange={(on) => change(id, on ? "on" : "off")}
		/>
	);

	const submitRule = async (rule: RuleDraft) => {
		try {
			await saveRule.mutateAsync({ ...zone, rule });
			await utils.cloudflareCache.rules.invalidate(zone);
			toast.success(rule.id ? "Rule updated" : "Rule added");
			setEditing(null);
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not save");
		}
	};

	const runPurge = async (
		input: Parameters<typeof purge.mutateAsync>[0]["purge"],
	) => {
		try {
			await purge.mutateAsync({ ...zone, purge: input });
			toast.success("Purge sent; Cloudflare clears it within seconds");
			setPurgeValues("");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not purge");
		}
	};

	const devMode = values?.development_mode;

	return (
		<div className="flex flex-col gap-10">
			<section className="flex flex-col gap-2">
				<SectionHeader
					title="Cache settings"
					description={`How Cloudflare caches ${zoneName || "this zone"}. Changes apply at Cloudflare's edge within a minute.`}
				/>
				{settings.isError ? (
					<AlertBlock type="error">{settings.error.message}</AlertBlock>
				) : (
					<div className="divide-y">
						<SettingRow
							title="Development mode"
							description={
								devMode?.value === "on" && devMode.timeRemaining
									? `On: the cache is bypassed for another ${Math.ceil(devMode.timeRemaining / 60)} minutes.`
									: "Bypass the cache for three hours while you change the site."
							}
						>
							{toggle("development_mode")}
						</SettingRow>
						<SettingRow
							title="Caching level"
							description="Which query strings make a cached copy unique."
						>
							<Select
								value={String(values?.cache_level?.value ?? "")}
								disabled={!canEdit || !values}
								onValueChange={(value) => change("cache_level", value)}
							>
								<SelectTrigger className="w-52">
									<SelectValue placeholder="…" />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="basic">No query string</SelectItem>
									<SelectItem value="simplified">
										Ignore query string
									</SelectItem>
									<SelectItem value="aggressive">Standard</SelectItem>
								</SelectContent>
							</Select>
						</SettingRow>
						<SettingRow
							title="Browser cache"
							description="How long visitors' browsers keep a file before asking again."
						>
							<Select
								value={String(values?.browser_cache_ttl?.value ?? "")}
								disabled={!canEdit || !values}
								onValueChange={(value) =>
									change("browser_cache_ttl", Number(value))
								}
							>
								<SelectTrigger className="w-52">
									<SelectValue placeholder="…" />
								</SelectTrigger>
								<SelectContent>
									{BROWSER_TTLS.map(([seconds, label]) => (
										<SelectItem key={seconds} value={String(seconds)}>
											{label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SettingRow>
						<SettingRow
							title="Smart tiered cache"
							description="Edge locations fetch from a nearby Cloudflare cache before your server, so the origin sees fewer requests."
						>
							<Switch
								checked={settings.data?.smartTieredCache === true}
								disabled={!canEdit || settings.data?.smartTieredCache === null}
								onCheckedChange={async (enabled) => {
									try {
										await setTiered.mutateAsync({ ...zone, enabled });
										await utils.cloudflareCache.settings.invalidate(zone);
									} catch (error) {
										toast.error(
											error instanceof Error ? error.message : "Could not save",
										);
									}
								}}
							/>
						</SettingRow>
						<SettingRow
							title="Always Online"
							description="Serve a cached copy when your server is down."
						>
							{toggle("always_online")}
						</SettingRow>
						<SettingRow
							title="Early Hints"
							description="Let browsers start loading assets before the page arrives."
						>
							{toggle("early_hints")}
						</SettingRow>
						<SettingRow
							title="HTTP/3"
							description="Faster connections on mobile and lossy networks."
						>
							{toggle("http3")}
						</SettingRow>
						<SettingRow
							title="0-RTT resumption"
							description="Returning visitors skip a round trip when reconnecting."
						>
							{toggle("0rtt")}
						</SettingRow>
					</div>
				)}
			</section>

			<section className="flex flex-col gap-2">
				<SectionHeader
					title="Cache rules"
					description="What to cache and for how long. Later rules win, so “never cache” rules always override."
					actions={
						canEdit && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button size="sm" variant="outline">
										<Plus className="size-4" />
										Add rule
										<ChevronDown className="size-3.5 text-muted-foreground" />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{presets(zoneName).map((preset) => (
										<DropdownMenuItem
											key={preset.label}
											onSelect={() => setEditing(preset.rule)}
										>
											{preset.label}
										</DropdownMenuItem>
									))}
									<DropdownMenuItem
										onSelect={() =>
											setEditing({
												name: "",
												hosts: [],
												pathPrefix: "",
												extensions: [],
												mode: "cache",
												edgeTtl: null,
												browserTtl: null,
												enabled: true,
											})
										}
									>
										Custom…
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)
					}
				/>
				{rules.isError ? (
					<AlertBlock type="error">{rules.error.message}</AlertBlock>
				) : rules.isPending ? (
					<p className="py-3 text-[13px] text-muted-foreground">Loading…</p>
				) : rules.data.owned.length === 0 && rules.data.foreign.length === 0 ? (
					<p className="py-3 text-[13px] text-muted-foreground">
						No rules yet. Cloudflare caches static file types by default; add a
						rule to keep them longer or to cache whole pages.
					</p>
				) : (
					<div className="divide-y">
						{rules.data.owned.map((rule) => (
							<div
								key={rule.id}
								className="flex items-center justify-between gap-4 py-3"
							>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium">{rule.name}</p>
									<p className="truncate text-[13px] text-muted-foreground">
										{describeMatch(rule)} — {describeAction(rule)}
									</p>
								</div>
								<div className="flex shrink-0 items-center gap-1">
									<Switch
										checked={rule.enabled}
										disabled={!canEdit}
										onCheckedChange={(enabled) =>
											submitRule({ ...rule, enabled })
										}
									/>
									{canEdit && (
										<>
											<Button
												variant="ghost"
												size="icon"
												className="size-8 text-muted-foreground"
												onClick={() => setEditing(rule)}
												aria-label="Edit rule"
											>
												<Pencil className="size-4" />
											</Button>
											<DialogAction
												title={`Delete “${rule.name}”?`}
												description="Cloudflare stops applying it within a minute."
												onClick={async () => {
													try {
														await deleteRule.mutateAsync({
															...zone,
															ruleId: rule.id as string,
														});
														await utils.cloudflareCache.rules.invalidate(zone);
													} catch (error) {
														toast.error(
															error instanceof Error
																? error.message
																: "Could not delete",
														);
													}
												}}
											>
												<Button
													variant="ghost"
													size="icon"
													className="size-8 text-muted-foreground hover:text-destructive"
													aria-label="Delete rule"
												>
													<Trash2 className="size-4" />
												</Button>
											</DialogAction>
										</>
									)}
								</div>
							</div>
						))}
						{rules.data.foreign.map((rule) => (
							<div key={rule.id} className="py-3 opacity-70">
								<p className="text-sm">
									{rule.name}{" "}
									<span className="text-xs text-muted-foreground">
										· made in the Cloudflare dashboard
									</span>
								</p>
								<p className="truncate font-mono text-xs text-muted-foreground">
									{rule.expression}
								</p>
							</div>
						))}
					</div>
				)}
			</section>

			<section className="flex flex-col gap-3">
				<SectionHeader
					title="Purge"
					description="Throw away cached copies so visitors get the newest version."
					actions={
						canEdit && (
							<DialogAction
								title="Purge everything?"
								description={`Every cached file for ${zoneName || "this zone"} is dropped. Your servers take the full load until the cache refills.`}
								onClick={() => runPurge({ kind: "everything" })}
							>
								<Button size="sm" variant="outline">
									Purge everything
								</Button>
							</DialogAction>
						)
					}
				/>
				{canEdit && (
					<div className="flex flex-col gap-2 sm:flex-row sm:items-start">
						<Select
							value={purgeKind}
							onValueChange={(value) => setPurgeKind(value as typeof purgeKind)}
						>
							<SelectTrigger className="sm:w-40">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="files">URLs</SelectItem>
								<SelectItem value="hosts">Hostnames</SelectItem>
								<SelectItem value="prefixes">Path prefixes</SelectItem>
							</SelectContent>
						</Select>
						<Textarea
							value={purgeValues}
							onChange={(event) => setPurgeValues(event.target.value)}
							placeholder={
								purgeKind === "files"
									? `https://${zoneName || "example.com"}/styles.css`
									: purgeKind === "hosts"
										? `www.${zoneName || "example.com"}`
										: `${zoneName || "example.com"}/blog/`
							}
							className="min-h-9 flex-1 font-mono text-xs"
							rows={2}
						/>
						<Button
							variant="secondary"
							disabled={!purgeValues.trim()}
							isLoading={purge.isPending}
							onClick={() =>
								runPurge({
									kind: purgeKind,
									values: purgeValues
										.split(/[\s,]+/)
										.map((value) => value.trim())
										.filter(Boolean),
								})
							}
						>
							Purge
						</Button>
					</div>
				)}
			</section>

			{editing && (
				<RuleDialog
					rule={editing}
					zoneName={zoneName}
					saving={saveRule.isPending}
					onClose={() => setEditing(null)}
					onSave={submitRule}
				/>
			)}
		</div>
	);
};

const list = (value: string) =>
	value
		.split(/[\s,]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);

const RuleDialog = ({
	rule,
	zoneName,
	saving,
	onClose,
	onSave,
}: {
	rule: RuleDraft;
	zoneName: string;
	saving: boolean;
	onClose: () => void;
	onSave: (rule: RuleDraft) => void;
}) => {
	const [draft, setDraft] = useState(rule);
	const [hosts, setHosts] = useState(rule.hosts.join(", "));
	const [extensions, setExtensions] = useState(rule.extensions.join(" "));
	const set = (patch: Partial<RuleDraft>) =>
		setDraft((current) => ({ ...current, ...patch }));
	const ttlSelect = (
		value: number | null,
		onChange: (value: number | null) => void,
	) => (
		<Select
			value={value === null ? "origin" : String(value)}
			onValueChange={(next) =>
				onChange(next === "origin" ? null : Number(next))
			}
		>
			<SelectTrigger>
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{RULE_TTLS.map(([seconds, label]) => (
					<SelectItem
						key={label}
						value={seconds === null ? "origin" : String(seconds)}
					>
						{label}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{rule.id ? "Edit cache rule" : "New cache rule"}
					</DialogTitle>
					<DialogDescription>
						Leave a match field empty to match everything.
					</DialogDescription>
				</DialogHeader>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						onSave({
							...draft,
							hosts: list(hosts),
							extensions: list(extensions),
						});
					}}
				>
					<div className="grid gap-1.5">
						<Label htmlFor="rule-name">Name</Label>
						<Input
							id="rule-name"
							value={draft.name}
							onChange={(event) => set({ name: event.target.value })}
							required
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="rule-hosts">Hostnames</Label>
						<Input
							id="rule-hosts"
							value={hosts}
							onChange={(event) => setHosts(event.target.value)}
							placeholder={`app.${zoneName || "example.com"}, *.${zoneName || "example.com"}`}
						/>
					</div>
					<div className="grid grid-cols-2 gap-3">
						<div className="grid gap-1.5">
							<Label htmlFor="rule-path">Path starts with</Label>
							<Input
								id="rule-path"
								value={draft.pathPrefix}
								onChange={(event) => set({ pathPrefix: event.target.value })}
								placeholder="/assets/"
							/>
						</div>
						<div className="grid gap-1.5">
							<Label htmlFor="rule-ext">File extensions</Label>
							<Input
								id="rule-ext"
								value={extensions}
								onChange={(event) => setExtensions(event.target.value)}
								placeholder="js css png"
							/>
						</div>
					</div>
					<div className="grid gap-1.5">
						<Label>Action</Label>
						<Select
							value={draft.mode}
							onValueChange={(mode) => set({ mode: mode as RuleDraft["mode"] })}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="cache">Cache it</SelectItem>
								<SelectItem value="bypass">Never cache it</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{draft.mode === "cache" && (
						<div className="grid grid-cols-2 gap-3">
							<div className="grid gap-1.5">
								<Label>Keep at Cloudflare for</Label>
								{ttlSelect(draft.edgeTtl, (edgeTtl) => set({ edgeTtl }))}
							</div>
							<div className="grid gap-1.5">
								<Label>Keep in browsers for</Label>
								{ttlSelect(draft.browserTtl, (browserTtl) =>
									set({ browserTtl }),
								)}
							</div>
						</div>
					)}
					<DialogFooter>
						<Button type="button" variant="ghost" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" isLoading={saving}>
							Save rule
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
};
