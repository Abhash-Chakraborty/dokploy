import { Layers, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { stringify } from "yaml";
import { DialogAction } from "@/components/shared/dialog-action";
import { InfoTooltip } from "@/components/shared/info-tooltip";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
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
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";

type Row = RouterOutputs["middlewares"]["list"][number];
type Report = RouterOutputs["middlewares"]["republish"];
type Scope = "manual" | "all" | "projects";

export const KINDS: Record<string, { label: string; hint: string }> = {
	rateLimit: {
		label: "Rate limit",
		hint: "Caps requests per client IP. Over the limit gets 429 Too Many Requests.",
	},
	ipAllowList: {
		label: "IP allowlist",
		hint: "Only these addresses or ranges get through; everyone else gets 403.",
	},
	basicAuth: {
		label: "Password protect",
		hint: "Browser username and password prompt in front of the site.",
	},
	securityHeaders: {
		label: "Security headers",
		hint: "HSTS, no framing, no MIME sniffing and a sane referrer policy.",
	},
	headers: {
		label: "Custom headers",
		hint: "Adds or overrides request and response headers.",
	},
	redirectRegex: {
		label: "Redirect",
		hint: "Rewrites matching URLs to another address, e.g. www to apex.",
	},
	compress: {
		label: "Compression",
		hint: "Gzip, Brotli or Zstd responses for clients that accept them.",
	},
	retry: {
		label: "Retry",
		hint: "Retries a request on another replica when the connection fails.",
	},
	inFlightReq: {
		label: "Concurrent request limit",
		hint: "Caps how many requests one client can have open at once.",
	},
	buffering: {
		label: "Request size limit",
		hint: "Rejects request bodies over the limit with 413.",
	},
	stripPrefix: {
		label: "Strip path prefix",
		hint: "Removes a leading path before the request reaches the service.",
	},
	custom: {
		label: "Custom (YAML)",
		hint: "Any other Traefik middleware, written as YAML.",
	},
};

const DEFAULTS: Record<string, Record<string, unknown>> = {
	rateLimit: { average: 100, burst: 50, period: "1s" },
	ipAllowList: { sourceRange: [] },
	basicAuth: { users: [{ username: "", password: "" }] },
	securityHeaders: {
		stsSeconds: 31536000,
		frameDeny: true,
		contentTypeNosniff: true,
		browserXssFilter: true,
		referrerPolicy: "strict-origin-when-cross-origin",
	},
	headers: { requestHeaders: {}, responseHeaders: {} },
	redirectRegex: { regex: "", replacement: "", permanent: true },
	compress: {},
	retry: { attempts: 3 },
	inFlightReq: { amount: 100 },
	buffering: { maxRequestBodyBytes: 10485760 },
	stripPrefix: { prefixes: [] },
	custom: { yaml: "ipAllowList:\n  sourceRange:\n    - 10.0.0.0/8\n" },
};

const showReport = (report: Report, verb: string) => {
	const failed = report.servers.filter((s) => !s.ok);
	if (failed.length || report.routes.failed.length) {
		toast.warning(`${verb}, with problems`, {
			description: [
				...failed.map((s) => `${s.name}: ${s.error}`),
				...report.routes.failed.map(
					(host) => `Route for ${host} did not update`,
				),
			].join("\n"),
		});
		return;
	}
	toast.success(verb, {
		description: `Written to ${report.servers.length} server${report.servers.length === 1 ? "" : "s"}, ${report.routes.updated} application route${report.routes.updated === 1 ? "" : "s"} updated. Compose services pick it up on their next deploy.`,
	});
};

const scopeLabel = (row: Row, projectNames: Map<string, string>) => {
	if (row.scope === "all") return "Every project";
	if (row.scope === "projects") {
		const names = row.projectIds.map((id) => projectNames.get(id) ?? id);
		return names.length ? names.join(", ") : "No projects";
	}
	return "Only where picked on a domain";
};

export const MiddlewaresPage = () => {
	const utils = api.useUtils();
	const { data: rows, isPending } = api.middlewares.list.useQuery();
	const { data: projects } = api.project.all.useQuery();
	const { data: me } = api.user.get.useQuery();
	const setEnabled = api.middlewares.setEnabled.useMutation();
	const remove = api.middlewares.remove.useMutation();
	const republish = api.middlewares.republish.useMutation();
	const [editing, setEditing] = useState<Row | "new" | null>(null);

	const projectNames = useMemo(
		() => new Map((projects ?? []).map((p) => [p.projectId, p.name] as const)),
		[projects],
	);
	const refresh = () => utils.middlewares.invalidate();

	return (
		<PageContainer>
			<PageHeader
				title={
					<span className="flex items-center gap-2">
						Middlewares
						<InfoTooltip
							content={
								<span>
									Dokploy writes each middleware to Traefik on every server this
									organization uses, so nothing is edited by hand. Scope decides
									where it applies: on domains you pick, on every project, or on
									chosen projects. Application routes update at once; compose
									services on their next deploy.
								</span>
							}
						/>
					</span>
				}
				description="Rate limits, allowlists, passwords and headers in front of your domains."
				icon={<Layers className="size-5" />}
				actions={
					<>
						<Button
							variant="outline"
							size="icon-sm"
							title="Write everything to the servers again"
							aria-label="Re-apply"
							isLoading={republish.isPending}
							onClick={async () => {
								await republish
									.mutateAsync()
									.then((report) => showReport(report, "Re-applied"))
									.catch((error: Error) => toast.error(error.message));
							}}
						>
							{!republish.isPending && <RefreshCw />}
						</Button>
						<Button size="sm" onClick={() => setEditing("new")}>
							<Plus className="size-4" />
							New middleware
						</Button>
					</>
				}
			/>

			{isPending ? (
				<p className="py-10 text-center text-sm text-muted-foreground">
					Loading…
				</p>
			) : !rows?.length ? (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-14 text-center">
					<Layers className="size-8 text-muted-foreground" />
					<p className="text-sm font-medium">No middlewares yet</p>
					<p className="max-w-sm text-sm text-muted-foreground">
						Add a rate limit, an IP allowlist or a password in front of your
						services, for every project or only some.
					</p>
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Middleware</TableHead>
								<TableHead>Type</TableHead>
								<TableHead>Applies to</TableHead>
								<TableHead className="w-20">On</TableHead>
								<TableHead className="w-24" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((row) => (
								<TableRow
									key={row.id}
									className={row.enabled ? "" : "opacity-60"}
								>
									<TableCell className="max-w-0">
										<div className="truncate text-sm font-medium">
											{row.name}
										</div>
										<div
											className="truncate font-mono text-[11px] text-muted-foreground"
											title="Name to use in labels or custom Traefik files"
										>
											{row.ref}
										</div>
									</TableCell>
									<TableCell className="text-sm">
										{KINDS[row.kind]?.label ?? row.kind}
									</TableCell>
									<TableCell>
										<div className="flex flex-wrap items-center gap-1">
											<span className="text-sm">
												{scopeLabel(row, projectNames)}
											</span>
											{row.applyToDashboard && (
												<Badge variant="outline">Dokploy dashboard</Badge>
											)}
										</div>
									</TableCell>
									<TableCell>
										<Switch
											checked={row.enabled}
											aria-label={`${row.name} on`}
											onCheckedChange={async (enabled) => {
												await setEnabled
													.mutateAsync({ id: row.id, enabled })
													.then(async (report) => {
														await refresh();
														showReport(
															report,
															enabled ? "Turned on" : "Turned off",
														);
													})
													.catch((error: Error) => toast.error(error.message));
											}}
										/>
									</TableCell>
									<TableCell className="text-right">
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Edit"
											title="Edit"
											onClick={() => setEditing(row)}
										>
											<Pencil />
										</Button>
										<DialogAction
											title={`Delete ${row.name}?`}
											description="Routes stop using it straight away. Compose services still referencing it keep working and drop it on their next deploy."
											type="destructive"
											onClick={async () => {
												await remove
													.mutateAsync({ id: row.id })
													.then(async (report) => {
														await refresh();
														showReport(report, "Deleted");
													})
													.catch((error: Error) => toast.error(error.message));
											}}
										>
											<Button
												variant="ghost"
												size="icon-sm"
												aria-label="Delete"
												title="Delete"
											>
												<Trash2 className="text-destructive" />
											</Button>
										</DialogAction>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}

			{editing && (
				<MiddlewareDialog
					row={editing === "new" ? null : editing}
					projects={projects ?? []}
					isOwner={me?.role === "owner"}
					onClose={() => setEditing(null)}
					onSaved={async (report, verb) => {
						await refresh();
						showReport(report, verb);
						setEditing(null);
					}}
				/>
			)}
		</PageContainer>
	);
};

const linesToList = (text: string) =>
	text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

const headersToText = (value: unknown) =>
	Object.entries((value as Record<string, string>) ?? {})
		.map(([name, v]) => `${name}: ${v}`)
		.join("\n");

const textToHeaders = (text: string) =>
	Object.fromEntries(
		linesToList(text)
			.map((line) => {
				const index = line.indexOf(":");
				return index > 0
					? [line.slice(0, index).trim(), line.slice(index + 1).trim()]
					: null;
			})
			.filter((pair): pair is [string, string] => !!pair),
	);

const MiddlewareDialog = ({
	row,
	projects,
	isOwner,
	onClose,
	onSaved,
}: {
	row: Row | null;
	projects: Array<{ projectId: string; name: string }>;
	isOwner: boolean;
	onClose: () => void;
	onSaved: (report: Report, verb: string) => Promise<void>;
}) => {
	const create = api.middlewares.create.useMutation();
	const update = api.middlewares.update.useMutation();
	const [name, setName] = useState(row?.name ?? "");
	const [description, setDescription] = useState(row?.description ?? "");
	const [kind, setKind] = useState(row?.kind ?? "rateLimit");
	const [config, setConfig] = useState<Record<string, unknown>>(
		(row?.config as Record<string, unknown>) ?? DEFAULTS.rateLimit ?? {},
	);
	const [scope, setScope] = useState<Scope>((row?.scope as Scope) ?? "manual");
	const [projectIds, setProjectIds] = useState<string[]>(row?.projectIds ?? []);
	const [dashboard, setDashboard] = useState(row?.applyToDashboard ?? false);

	useEffect(() => {
		if (!row || row.kind !== kind) setConfig(DEFAULTS[kind] ?? {});
	}, [kind, row]);

	const set = (key: string, value: unknown) =>
		setConfig((current) => ({ ...current, [key]: value }));
	const num = (key: string) => (
		<Input
			type="number"
			value={String(config[key] ?? "")}
			onChange={(e) => set(key, Number(e.target.value))}
		/>
	);

	const save = async () => {
		const payload = {
			name,
			description: description || undefined,
			config: { kind, ...config } as never,
			scope,
			projectIds,
			applyToDashboard: dashboard,
			enabled: row?.enabled ?? true,
		};
		try {
			const report = row
				? await update.mutateAsync({ ...payload, id: row.id })
				: await create.mutateAsync(payload);
			await onSaved(report, row ? "Saved" : "Created");
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not save");
		}
	};

	return (
		<Dialog open onOpenChange={(open) => !open && onClose()}>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{row ? `Edit ${row.name}` : "New middleware"}
					</DialogTitle>
					<DialogDescription>{KINDS[kind]?.hint}</DialogDescription>
				</DialogHeader>

				<div className="grid gap-4">
					<div className="grid gap-4 sm:grid-cols-2">
						<div className="grid gap-1.5">
							<Label htmlFor="mw-name">Name</Label>
							<Input
								id="mw-name"
								value={name}
								disabled={!!row}
								placeholder="api-rate-limit"
								onChange={(e) => setName(e.target.value.toLowerCase())}
							/>
						</div>
						<div className="grid gap-1.5">
							<Label>Type</Label>
							<Select value={kind} onValueChange={setKind}>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									{Object.entries(KINDS).map(([id, meta]) => (
										<SelectItem key={id} value={id}>
											{meta.label}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="mw-description">Description</Label>
						<Input
							id="mw-description"
							value={description}
							placeholder="What it is for"
							onChange={(e) => setDescription(e.target.value)}
						/>
					</div>

					<fieldset className="grid gap-3 rounded-lg border p-3">
						<legend className="px-1 text-sm font-medium">Settings</legend>
						{kind === "rateLimit" && (
							<div className="grid gap-3 sm:grid-cols-3">
								<div className="grid gap-1.5">
									<Label className="flex items-center gap-1.5">
										Average
										<InfoTooltip content="Requests allowed per period, per client IP, on average." />
									</Label>
									{num("average")}
								</div>
								<div className="grid gap-1.5">
									<Label className="flex items-center gap-1.5">
										Burst
										<InfoTooltip content="Extra requests allowed in a short spike." />
									</Label>
									{num("burst")}
								</div>
								<div className="grid gap-1.5">
									<Label>Period</Label>
									<Select
										value={String(config.period ?? "1s")}
										onValueChange={(value) => set("period", value)}
									>
										<SelectTrigger>
											<SelectValue />
										</SelectTrigger>
										<SelectContent>
											{["1s", "10s", "1m", "1h"].map((p) => (
												<SelectItem key={p} value={p}>
													per {p}
												</SelectItem>
											))}
										</SelectContent>
									</Select>
								</div>
							</div>
						)}
						{kind === "ipAllowList" && (
							<div className="grid gap-1.5">
								<Label>Allowed addresses, one per line</Label>
								<Textarea
									rows={4}
									className="font-mono text-xs"
									placeholder={"203.0.113.10\n10.0.0.0/8\n100.64.0.0/10"}
									value={((config.sourceRange as string[]) ?? []).join("\n")}
									onChange={(e) =>
										set("sourceRange", linesToList(e.target.value))
									}
								/>
							</div>
						)}
						{kind === "basicAuth" && (
							<div className="grid gap-2">
								{(
									(config.users as Array<{
										username: string;
										password: string;
									}>) ?? []
								).map((user, index, users) => (
									<div key={index} className="flex gap-2">
										<Input
											placeholder="Username"
											value={user.username}
											onChange={(e) => {
												const next = [...users];
												next[index] = { ...user, username: e.target.value };
												set("users", next);
											}}
										/>
										<Input
											type="password"
											placeholder={row ? "Leave blank to keep" : "Password"}
											value={user.password}
											onChange={(e) => {
												const next = [...users];
												next[index] = { ...user, password: e.target.value };
												set("users", next);
											}}
										/>
										<Button
											variant="ghost"
											size="icon-sm"
											aria-label="Remove user"
											disabled={users.length === 1}
											onClick={() =>
												set(
													"users",
													users.filter((_, i) => i !== index),
												)
											}
										>
											<Trash2 />
										</Button>
									</div>
								))}
								<Button
									variant="outline"
									size="sm"
									className="w-fit"
									onClick={() =>
										set("users", [
											...((config.users as unknown[]) ?? []),
											{ username: "", password: "" },
										])
									}
								>
									<Plus className="size-4" /> Add user
								</Button>
							</div>
						)}
						{kind === "securityHeaders" && (
							<div className="grid gap-3">
								<div className="grid gap-1.5 sm:w-1/2">
									<Label>HSTS max age (seconds)</Label>
									{num("stsSeconds")}
								</div>
								{(
									[
										["frameDeny", "Forbid framing (clickjacking)"],
										["contentTypeNosniff", "No MIME sniffing"],
										["browserXssFilter", "Legacy XSS filter header"],
									] as const
								).map(([key, label]) => (
									<Label key={key} className="flex items-center gap-2 text-sm">
										<Checkbox
											checked={config[key] !== false}
											onCheckedChange={(checked) => set(key, checked === true)}
										/>
										{label}
									</Label>
								))}
							</div>
						)}
						{kind === "headers" && (
							<div className="grid gap-3 sm:grid-cols-2">
								{(
									[
										["requestHeaders", "Request headers"],
										["responseHeaders", "Response headers"],
									] as const
								).map(([key, label]) => (
									<div key={key} className="grid gap-1.5">
										<Label>{label}</Label>
										<Textarea
											rows={4}
											className="font-mono text-xs"
											placeholder="X-Frame-Options: SAMEORIGIN"
											defaultValue={headersToText(config[key])}
											onChange={(e) => set(key, textToHeaders(e.target.value))}
										/>
									</div>
								))}
							</div>
						)}
						{kind === "redirectRegex" && (
							<div className="grid gap-3">
								<div className="grid gap-1.5">
									<Label>Match (regex)</Label>
									<Input
										className="font-mono"
										placeholder="^https?://www\.(.+)"
										value={String(config.regex ?? "")}
										onChange={(e) => set("regex", e.target.value)}
									/>
								</div>
								<div className="grid gap-1.5">
									<Label>Replace with</Label>
									<Input
										className="font-mono"
										placeholder="https://${1}"
										value={String(config.replacement ?? "")}
										onChange={(e) => set("replacement", e.target.value)}
									/>
								</div>
								<Label className="flex items-center gap-2 text-sm">
									<Checkbox
										checked={config.permanent === true}
										onCheckedChange={(checked) =>
											set("permanent", checked === true)
										}
									/>
									Permanent (301)
								</Label>
							</div>
						)}
						{kind === "compress" && (
							<p className="text-sm text-muted-foreground">Nothing to set.</p>
						)}
						{kind === "retry" && (
							<div className="grid gap-1.5 sm:w-1/2">
								<Label>Attempts</Label>
								{num("attempts")}
							</div>
						)}
						{kind === "inFlightReq" && (
							<div className="grid gap-1.5 sm:w-1/2">
								<Label>Open requests per client</Label>
								{num("amount")}
							</div>
						)}
						{kind === "buffering" && (
							<div className="grid gap-1.5 sm:w-1/2">
								<Label>Largest request body (bytes)</Label>
								{num("maxRequestBodyBytes")}
							</div>
						)}
						{kind === "stripPrefix" && (
							<div className="grid gap-1.5">
								<Label>Prefixes, one per line</Label>
								<Textarea
									rows={3}
									className="font-mono text-xs"
									placeholder="/api"
									value={((config.prefixes as string[]) ?? []).join("\n")}
									onChange={(e) => set("prefixes", linesToList(e.target.value))}
								/>
							</div>
						)}
						{kind === "custom" && (
							<div className="grid gap-1.5">
								<Label className="flex items-center gap-1.5">
									Middleware YAML
									<InfoTooltip content="Exactly one Traefik middleware, the part under its name, e.g. `ipAllowList:` with its options." />
								</Label>
								<Textarea
									rows={8}
									className="font-mono text-xs"
									value={String(config.yaml ?? "")}
									onChange={(e) => set("yaml", e.target.value)}
								/>
							</div>
						)}
					</fieldset>

					<fieldset className="grid gap-3 rounded-lg border p-3">
						<legend className="px-1 text-sm font-medium">Applies to</legend>
						{(
							[
								[
									"manual",
									"Only domains where I pick it",
									"Choose it in a domain's settings.",
								],
								[
									"all",
									"Every project",
									"All domains in this organization, now and later.",
								],
								[
									"projects",
									"Selected projects",
									"All domains in the projects ticked below.",
								],
							] as const
						).map(([value, label, hint]) => (
							<label
								key={value}
								className="flex cursor-pointer items-start gap-2 text-sm"
							>
								<input
									type="radio"
									name="mw-scope"
									className="mt-1"
									checked={scope === value}
									onChange={() => setScope(value)}
								/>
								<span>
									{label}
									<span className="block text-xs text-muted-foreground">
										{hint}
									</span>
								</span>
							</label>
						))}
						{scope === "projects" && (
							<div className="grid max-h-40 gap-1.5 overflow-y-auto rounded-md border p-2 sm:grid-cols-2">
								{projects.map((project) => (
									<Label
										key={project.projectId}
										className="flex items-center gap-2 text-sm"
									>
										<Checkbox
											checked={projectIds.includes(project.projectId)}
											onCheckedChange={(checked) =>
												setProjectIds((current) =>
													checked
														? [...current, project.projectId]
														: current.filter((id) => id !== project.projectId),
												)
											}
										/>
										<span className="truncate">{project.name}</span>
									</Label>
								))}
							</div>
						)}
						<Label
							className={`flex items-start gap-2 text-sm ${isOwner ? "" : "opacity-60"}`}
							title={isOwner ? undefined : "Only the owner can change this"}
						>
							<Checkbox
								className="mt-0.5"
								checked={dashboard}
								disabled={!isOwner}
								onCheckedChange={(checked) => setDashboard(checked === true)}
							/>
							<span>
								Also the Dokploy dashboard
								<span className="block text-xs text-muted-foreground">
									Test it on a project first: a wrong allowlist or password here
									locks everyone out of Dokploy.
								</span>
							</span>
						</Label>
					</fieldset>

					{row && (
						<details className="rounded-lg border px-3 py-2 text-sm">
							<summary className="cursor-pointer text-muted-foreground">
								What Traefik receives
							</summary>
							<pre className="mt-2 overflow-x-auto font-mono text-xs">
								{stringify({ [row.ref.replace(/@file$/, "")]: row.preview })}
							</pre>
						</details>
					)}
				</div>

				<DialogFooter>
					<Button variant="outline" onClick={onClose}>
						Cancel
					</Button>
					<Button
						onClick={save}
						isLoading={create.isPending || update.isPending}
						disabled={!name}
					>
						{row ? "Save" : "Create"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
