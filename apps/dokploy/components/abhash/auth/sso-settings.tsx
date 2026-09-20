import {
	Check,
	Copy,
	PenLine,
	Plus,
	ShieldCheck,
	Trash2,
	TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
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
import { api, type RouterOutputs } from "@/utils/api";

type Provider = RouterOutputs["abhashSso"]["providers"][number];

const EMPTY = {
	providerId: "",
	displayName: "Authentik",
	kind: "authentik" as "authentik" | "generic",
	authentikUrl: "",
	authentikSlug: "dokploy",
	discoveryUrl: "",
	clientId: "",
	clientSecret: "",
	domains: "",
	groupsClaim: "groups",
	trustForLinking: false,
	enabled: true,
	showOnLogin: true,
	jitEnabled: true,
	requireGroupMatch: false,
	defaultRole: "member",
	maxRole: "admin" as "admin" | "member",
};
type Form = typeof EMPTY;

const fromProvider = (p: Provider): Form => {
	const match = p.discoveryUrl.match(
		/^(.*)\/application\/o\/([^/]+)\/\.well-known/,
	);
	return {
		...EMPTY,
		...p,
		authentikUrl: match?.[1] ?? "",
		authentikSlug: match?.[2] ?? "",
		clientSecret: "",
		domains: p.domains.join(", "),
	};
};

const Toggle = ({
	id,
	label,
	hint,
	checked,
	onChange,
}: {
	id: string;
	label: string;
	hint: ReactNode;
	checked: boolean;
	onChange: (v: boolean) => void;
}) => (
	<div className="flex items-start justify-between gap-4">
		<div>
			<Label htmlFor={id}>{label}</Label>
			<p className="text-xs text-muted-foreground">{hint}</p>
		</div>
		<Switch id={id} checked={checked} onCheckedChange={onChange} />
	</div>
);

const CopyValue = ({ value }: { value: string }) => {
	const [copied, setCopied] = useState(false);
	return (
		<div className="flex items-center gap-2 rounded-md border bg-muted/40 px-2 py-1.5">
			<code className="flex-1 truncate text-xs">{value}</code>
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="size-6"
				aria-label="Copy"
				onClick={async () => {
					await navigator.clipboard.writeText(value);
					setCopied(true);
					setTimeout(() => setCopied(false), 1500);
				}}
			>
				{copied ? <Check className="size-3" /> : <Copy className="size-3" />}
			</Button>
		</div>
	);
};

const ProviderDialog = ({
	initial,
	children,
}: {
	initial?: Provider;
	children: ReactNode;
}) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<Form>(EMPTY);
	const [issuer, setIssuer] = useState<string | null>(null);
	const { data: roles } = api.customRole.all.useQuery(undefined, {
		enabled: open,
	});
	const test = api.abhashSso.testDiscovery.useMutation();
	const create = api.abhashSso.createProvider.useMutation();
	const update = api.abhashSso.updateProvider.useMutation();
	const set = <K extends keyof Form>(key: K, value: Form[K]) =>
		setForm((f) => ({ ...f, [key]: value }));

	useEffect(() => {
		if (open) {
			setForm(initial ? fromProvider(initial) : EMPTY);
			setIssuer(null);
		}
	}, [open, initial]);

	const origin = typeof window === "undefined" ? "" : window.location.origin;
	const redirectUri = `${origin}/api/auth/sso/callback/${form.providerId || "<provider-id>"}`;

	const payload = () => ({
		...form,
		clientSecret: form.clientSecret || undefined,
		domains: form.domains
			.split(/[,\s]+/)
			.map((d) => d.trim())
			.filter(Boolean),
		scopes: ["openid", "email", "profile"],
		authentikUrl: form.kind === "authentik" ? form.authentikUrl : undefined,
		authentikSlug: form.kind === "authentik" ? form.authentikSlug : undefined,
		discoveryUrl: form.kind === "generic" ? form.discoveryUrl : undefined,
	});

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{children}</DialogTrigger>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>
						{initial
							? `Edit ${initial.displayName}`
							: "Add an identity provider"}
					</DialogTitle>
					<DialogDescription>
						OpenID Connect. In Authentik, create an OAuth2/OpenID provider and
						an application, then paste its details here.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-5">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label>Type</Label>
							<Select
								value={form.kind}
								onValueChange={(v) => set("kind", v as Form["kind"])}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="authentik">Authentik</SelectItem>
									<SelectItem value="generic">Other OpenID Connect</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="sso-name">Button label</Label>
							<Input
								id="sso-name"
								value={form.displayName}
								onChange={(e) => set("displayName", e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="sso-id">Provider ID</Label>
							<Input
								id="sso-id"
								disabled={!!initial}
								placeholder="authentik"
								value={form.providerId}
								onChange={(e) =>
									set(
										"providerId",
										e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
									)
								}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="sso-domains">Email domains</Label>
							<Input
								id="sso-domains"
								placeholder="company.com, company.io"
								value={form.domains}
								onChange={(e) => set("domains", e.target.value)}
							/>
						</div>
					</div>

					<div className="flex flex-col gap-3 rounded-md border p-3">
						{form.kind === "authentik" ? (
							<div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="ak-url">Authentik URL</Label>
									<Input
										id="ak-url"
										placeholder="https://auth.company.com"
										value={form.authentikUrl}
										onChange={(e) => set("authentikUrl", e.target.value)}
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="ak-slug">Application slug</Label>
									<Input
										id="ak-slug"
										value={form.authentikSlug}
										onChange={(e) => set("authentikSlug", e.target.value)}
									/>
								</div>
							</div>
						) : (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="disc">Discovery URL</Label>
								<Input
									id="disc"
									placeholder="https://idp.company.com/.well-known/openid-configuration"
									value={form.discoveryUrl}
									onChange={(e) => set("discoveryUrl", e.target.value)}
								/>
							</div>
						)}
						<div className="flex items-center gap-3">
							<Button
								type="button"
								variant="outline"
								size="sm"
								isLoading={test.isPending}
								onClick={async () => {
									await test
										.mutateAsync(payload())
										.then((r) => setIssuer(r.issuer))
										.catch((error: Error) => {
											setIssuer(null);
											toast.error(error.message);
										});
								}}
							>
								Test connection
							</Button>
							{issuer && (
								<span className="flex items-center gap-1 text-xs text-green-600">
									<Check className="size-3" /> Found issuer {issuer}
								</span>
							)}
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="cid">Client ID</Label>
								<Input
									id="cid"
									value={form.clientId}
									onChange={(e) => set("clientId", e.target.value)}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="csecret">Client secret</Label>
								<Input
									id="csecret"
									type="password"
									placeholder={initial?.hasClientSecret ? "Unchanged" : ""}
									value={form.clientSecret}
									onChange={(e) => set("clientSecret", e.target.value)}
								/>
							</div>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Redirect URI to register in the provider</Label>
							<CopyValue value={redirectUri} />
						</div>
					</div>

					<div className="grid gap-3 sm:grid-cols-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="gclaim">Groups claim</Label>
							<Input
								id="gclaim"
								value={form.groupsClaim}
								onChange={(e) => set("groupsClaim", e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Default role</Label>
							<Select
								value={form.defaultRole}
								onValueChange={(v) => set("defaultRole", v)}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="member">Member</SelectItem>
									<SelectItem value="admin">Admin</SelectItem>
									{roles?.map((r) => (
										<SelectItem key={r.role} value={r.role}>
											{r.role}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Groups may grant up to</Label>
							<Select
								value={form.maxRole}
								onValueChange={(v) => set("maxRole", v as Form["maxRole"])}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="admin">Admin</SelectItem>
									<SelectItem value="member">Member</SelectItem>
								</SelectContent>
							</Select>
						</div>
					</div>

					<div className="flex flex-col gap-3">
						<Toggle
							id="sso-enabled"
							label="Enabled"
							hint="People can sign in with this provider."
							checked={form.enabled}
							onChange={(v) => set("enabled", v)}
						/>
						<Toggle
							id="sso-show"
							label="Show on the sign-in page"
							hint="Otherwise reachable through “Sign in with your work email”."
							checked={form.showOnLogin}
							onChange={(v) => set("showOnLogin", v)}
						/>
						<Toggle
							id="sso-jit"
							label="Create accounts on first sign-in"
							hint="Off: only people with a pending invitation can join."
							checked={form.jitEnabled}
							onChange={(v) => set("jitEnabled", v)}
						/>
						<Toggle
							id="sso-require"
							label="Require a mapped group"
							hint="Refuse sign-in when none of the person’s groups is mapped below."
							checked={form.requireGroupMatch}
							onChange={(v) => set("requireGroupMatch", v)}
						/>
						<Toggle
							id="sso-trust"
							label="Link existing accounts by email"
							hint={
								<span className="flex items-start gap-1 text-amber-600">
									<TriangleAlert className="mt-0.5 size-3 shrink-0" />
									Lets this provider sign into an existing Dokploy account whose
									email is on the domains above. Only enable for a provider you
									fully control.
								</span>
							}
							checked={form.trustForLinking}
							onChange={(v) => set("trustForLinking", v)}
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						isLoading={create.isPending || update.isPending}
						onClick={async () => {
							const request = initial
								? update.mutateAsync(payload())
								: create.mutateAsync(payload());
							await request
								.then(async () => {
									await utils.abhashSso.invalidate();
									toast.success(initial ? "Provider saved" : "Provider added");
									setOpen(false);
								})
								.catch((error: Error) => toast.error(error.message));
						}}
					>
						{initial ? "Save" : "Add provider"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const GroupMappings = ({ providers }: { providers: Provider[] }) => {
	const utils = api.useUtils();
	const { data: mappings } = api.abhashSso.mappings.list.useQuery();
	const { data: teams } = api.access.teams.list.useQuery();
	const { data: roles } = api.customRole.all.useQuery();
	const create = api.abhashSso.mappings.create.useMutation();
	const remove = api.abhashSso.mappings.remove.useMutation();
	const [group, setGroup] = useState("");
	const [role, setRole] = useState("none");
	const [team, setTeam] = useState("none");
	const [provider, setProvider] = useState("any");
	const [priority, setPriority] = useState("0");
	const teamName = (id: string | null) => teams?.find((t) => t.id === id)?.name;

	return (
		<div className="flex flex-col gap-3">
			<div>
				<h3 className="text-sm font-medium">Group mappings</h3>
				<p className="text-sm text-muted-foreground">
					Applied at every sign-in. The highest-priority matching role wins;
					teams from every matching group are joined. Without a match the
					default role applies.
				</p>
			</div>
			{mappings && mappings.length > 0 && (
				<ul className="divide-y rounded-md border">
					{mappings.map((m) => (
						<li
							key={m.id}
							className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm"
						>
							<code className="rounded bg-muted px-1.5 py-0.5 text-xs">
								{m.groupName}
							</code>
							<span className="text-muted-foreground">→</span>
							{m.orgRole && <Badge variant="secondary">{m.orgRole}</Badge>}
							{m.teamId && (
								<Badge variant="outline">
									team: {teamName(m.teamId) ?? "deleted"}
								</Badge>
							)}
							<span className="text-xs text-muted-foreground">
								{m.providerId ?? "any provider"} · priority {m.priority}
							</span>
							<Button
								variant="ghost"
								size="icon"
								className="ml-auto size-7"
								aria-label="Remove mapping"
								onClick={async () => {
									await remove
										.mutateAsync({ id: m.id })
										.then(() => utils.abhashSso.mappings.invalidate())
										.catch((error: Error) => toast.error(error.message));
								}}
							>
								<Trash2 className="size-4" />
							</Button>
						</li>
					))}
				</ul>
			)}
			<div className="grid gap-2 rounded-md border bg-muted/30 p-3 sm:grid-cols-[1fr_9rem_9rem_9rem_5rem_auto] sm:items-end">
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="map-group">Group name</Label>
					<Input
						id="map-group"
						placeholder="dokploy-admins"
						value={group}
						onChange={(e) => setGroup(e.target.value)}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label>Role</Label>
					<Select value={role} onValueChange={setRole}>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">No role</SelectItem>
							<SelectItem value="member">Member</SelectItem>
							<SelectItem value="admin">Admin</SelectItem>
							{roles?.map((r) => (
								<SelectItem key={r.role} value={r.role}>
									{r.role}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label>Team</Label>
					<Select value={team} onValueChange={setTeam}>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">No team</SelectItem>
							{teams?.map((t) => (
								<SelectItem key={t.id} value={t.id}>
									{t.name}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label>Provider</Label>
					<Select value={provider} onValueChange={setProvider}>
						<SelectTrigger>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="any">Any provider</SelectItem>
							{providers.map((p) => (
								<SelectItem key={p.providerId} value={p.providerId}>
									{p.displayName}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="map-priority">Priority</Label>
					<Input
						id="map-priority"
						type="number"
						min={0}
						value={priority}
						onChange={(e) => setPriority(e.target.value)}
					/>
				</div>
				<Button
					disabled={!group.trim() || (role === "none" && team === "none")}
					isLoading={create.isPending}
					onClick={async () => {
						await create
							.mutateAsync({
								groupName: group,
								orgRole: role === "none" ? null : role,
								teamId: team === "none" ? null : team,
								providerId: provider === "any" ? null : provider,
								priority: Number(priority) || 0,
							})
							.then(async () => {
								await utils.abhashSso.mappings.invalidate();
								setGroup("");
							})
							.catch((error: Error) => toast.error(error.message));
					}}
				>
					<Plus className="size-4" />
					Add
				</Button>
			</div>
		</div>
	);
};

const EnforceCard = ({ providers }: { providers: Provider[] }) => {
	const utils = api.useUtils();
	const { data: status } = api.abhashSso.status.useQuery();
	const setEnforce = api.abhashSso.setEnforce.useMutation();
	const proven = providers.some((p) => p.enabled && p.lastLoginAt);
	if (!status) return null;
	const save = async (next: { enabled: boolean; allowPasskey: boolean }) => {
		await setEnforce
			.mutateAsync(next)
			.then(() => utils.abhashSso.invalidate())
			.catch((error: Error) => toast.error(error.message));
	};
	return (
		<div className="flex flex-col gap-3 rounded-lg border p-4">
			<Toggle
				id="enforce"
				label="Require single sign-on"
				hint={
					proven
						? "Passwords and GitHub/Google sign-in stop working. Organization owners keep a password emergency sign-in, which is audited."
						: "Sign in once through an enabled provider first, so you know it works."
				}
				checked={status.enforce.enabled}
				onChange={(enabled) => save({ ...status.enforce, enabled })}
			/>
			{status.enforce.enabled && (
				<Toggle
					id="enforce-passkey"
					label="Still allow passkeys"
					hint="Passkeys are phishing-resistant; keep them as a second way in."
					checked={status.enforce.allowPasskey}
					onChange={(allowPasskey) => save({ ...status.enforce, allowPasskey })}
				/>
			)}
			<p className="text-xs text-muted-foreground">
				Locked out? Run <code>pnpm run reset-sso</code> inside the Dokploy
				container to turn enforcement off and re-enable every login method.
			</p>
		</div>
	);
};

export const SsoSettings = () => {
	const utils = api.useUtils();
	const { data: me } = api.user.get.useQuery();
	const { data: status } = api.abhashSso.status.useQuery();
	const { data: providers } = api.abhashSso.providers.useQuery();
	const setEnabled = api.abhashSso.setEnabled.useMutation();
	const remove = api.abhashSso.deleteProvider.useMutation();
	const isOwner = me?.role === "owner";

	return (
		<section className="flex flex-col gap-6">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-lg font-medium">
						<ShieldCheck className="size-5 text-muted-foreground" />
						Single sign-on
					</h2>
					<p className="text-sm text-muted-foreground">
						Sign in with Authentik or any OpenID Connect provider, with roles
						and teams taken from its groups.
					</p>
				</div>
				<div className="flex items-center gap-3">
					{isOwner && status && (
						<div className="flex items-center gap-2">
							<Label htmlFor="sso-on">SSO</Label>
							<Switch
								id="sso-on"
								checked={status.enabled}
								onCheckedChange={async (enabled) => {
									await setEnabled
										.mutateAsync({ enabled })
										.then(() => utils.abhashSso.invalidate())
										.catch((error: Error) => toast.error(error.message));
								}}
							/>
						</div>
					)}
					<ProviderDialog>
						<Button>
							<Plus className="size-4" />
							Add provider
						</Button>
					</ProviderDialog>
				</div>
			</div>

			{status && !status.enabled && (
				<p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
					SSO is off: providers can be set up, but nobody can sign in with them
					until the owner turns it on.
				</p>
			)}

			{!providers?.length ? (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-10 text-center">
					<ShieldCheck className="size-8 text-muted-foreground" />
					<p className="text-sm font-medium">No identity provider yet</p>
					<p className="max-w-sm text-sm text-muted-foreground">
						Add Authentik to let your team sign in with the accounts they
						already have.
					</p>
				</div>
			) : (
				<div className="grid gap-3 md:grid-cols-2">
					{providers.map((p) => (
						<div
							key={p.providerId}
							className="flex flex-col gap-2 rounded-lg border p-4"
						>
							<div className="flex items-start justify-between gap-2">
								<div className="min-w-0">
									<p className="truncate font-medium">{p.displayName}</p>
									<p className="truncate text-xs text-muted-foreground">
										{p.issuer}
									</p>
								</div>
								<div className="flex shrink-0">
									<ProviderDialog initial={p}>
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Edit ${p.displayName}`}
										>
											<PenLine className="size-4" />
										</Button>
									</ProviderDialog>
									<DialogAction
										title={`Delete ${p.displayName}?`}
										description="People who only sign in with this provider will no longer be able to sign in."
										type="destructive"
										onClick={async () => {
											await remove
												.mutateAsync({ providerId: p.providerId })
												.then(() => utils.abhashSso.invalidate())
												.catch((error: Error) => toast.error(error.message));
										}}
									>
										<Button
											variant="ghost"
											size="icon"
											aria-label={`Delete ${p.displayName}`}
											className="text-destructive hover:text-destructive"
										>
											<Trash2 className="size-4" />
										</Button>
									</DialogAction>
								</div>
							</div>
							<div className="flex flex-wrap gap-1">
								<Badge variant={p.enabled ? "default" : "outline"}>
									{p.enabled ? "Enabled" : "Disabled"}
								</Badge>
								<Badge variant="outline" className="capitalize">
									{p.kind}
								</Badge>
								{p.jitEnabled ? (
									<Badge variant="outline">Just-in-time</Badge>
								) : (
									<Badge variant="outline">Invite only</Badge>
								)}
								{p.trustForLinking && (
									<Badge variant="destructive">Links accounts</Badge>
								)}
							</div>
							<p className="text-xs text-muted-foreground">
								{p.domains.join(", ")} ·{" "}
								{p.lastLoginAt
									? `last sign-in ${new Date(p.lastLoginAt).toLocaleString()}`
									: "no sign-ins yet"}
							</p>
						</div>
					))}
				</div>
			)}

			{providers && providers.length > 0 && (
				<GroupMappings providers={providers} />
			)}
			{isOwner && providers && providers.length > 0 && (
				<EnforceCard providers={providers} />
			)}
		</section>
	);
};
