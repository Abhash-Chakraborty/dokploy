import { formatDistanceToNow } from "date-fns";
import {
	Copy,
	DownloadCloud,
	Eye,
	History,
	KeyRound,
	Plus,
	RotateCw,
	Trash2,
	Upload,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { PageHeader } from "@/components/shared/page-header";
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
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";

type Secret = RouterOutputs["vault"]["list"][number];
type ScopeType = "organization" | "project" | "environment";

const fail = (error: Error) => toast.error(error.message);

const ScopePicker = ({
	scopeType,
	scopeId,
	onChange,
	canUseOrganization,
}: {
	scopeType: ScopeType;
	scopeId: string;
	onChange: (scopeType: ScopeType, scopeId: string) => void;
	canUseOrganization: boolean;
}) => {
	const { data: scopes } = api.vault.scopes.useQuery();
	return (
		<div className="grid gap-3 sm:grid-cols-2">
			<div className="flex flex-col gap-1.5">
				<Label>Available in</Label>
				<Select
					value={scopeType}
					onValueChange={(value) => onChange(value as ScopeType, "")}
				>
					<SelectTrigger>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{canUseOrganization && (
							<SelectItem value="organization">Every project</SelectItem>
						)}
						<SelectItem value="project">One project</SelectItem>
						<SelectItem value="environment">One environment</SelectItem>
					</SelectContent>
				</Select>
			</div>
			{scopeType !== "organization" && (
				<div className="flex flex-col gap-1.5">
					<Label>{scopeType === "project" ? "Project" : "Environment"}</Label>
					<Select
						value={scopeId}
						onValueChange={(value) => onChange(scopeType, value)}
					>
						<SelectTrigger>
							<SelectValue placeholder="Choose…" />
						</SelectTrigger>
						<SelectContent>
							{scopes?.flatMap((project) =>
								scopeType === "project"
									? [
											<SelectItem
												key={project.projectId}
												value={project.projectId}
											>
												{project.name}
											</SelectItem>,
										]
									: project.environments.map((environment) => (
											<SelectItem
												key={environment.environmentId}
												value={environment.environmentId}
											>
												{project.name} / {environment.name}
											</SelectItem>
										)),
							)}
						</SelectContent>
					</Select>
				</div>
			)}
		</div>
	);
};

const CreateSecret = ({
	canUseOrganization,
}: {
	canUseOrganization: boolean;
}) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [value, setValue] = useState("");
	const [scopeType, setScopeType] = useState<ScopeType>(
		canUseOrganization ? "organization" : "project",
	);
	const [scopeId, setScopeId] = useState("");
	const create = api.vault.create.useMutation();

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<Plus className="size-4" />
					New secret
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New secret</DialogTitle>
					<DialogDescription>
						The value is write-only: once saved, nobody but the organization
						owner can read it back. Use it anywhere with{" "}
						<code>{"${{secret.NAME}}"}</code>.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label>Name</Label>
							<Input
								value={name}
								placeholder="STRIPE_API_KEY"
								onChange={(e) => setName(e.target.value.toUpperCase())}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Description</Label>
							<Input
								value={description}
								placeholder="Live key for billing"
								onChange={(e) => setDescription(e.target.value)}
							/>
						</div>
					</div>
					<ScopePicker
						scopeType={scopeType}
						scopeId={scopeId}
						canUseOrganization={canUseOrganization}
						onChange={(type, id) => {
							setScopeType(type);
							setScopeId(id);
						}}
					/>
					<div className="flex flex-col gap-1.5">
						<Label>Value</Label>
						<Textarea
							value={value}
							rows={3}
							spellCheck={false}
							onChange={(e) => setValue(e.target.value)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						isLoading={create.isPending}
						onClick={async () => {
							await create
								.mutateAsync({
									name,
									description,
									value,
									tags: [],
									expiresAt: null,
									rotateEveryDays: null,
									scopeType,
									scopeId: scopeType === "organization" ? undefined : scopeId,
								})
								.then(async () => {
									toast.success(`${name} saved`);
									await utils.vault.list.invalidate();
									setOpen(false);
									setName("");
									setDescription("");
									setValue("");
								})
								.catch(fail);
						}}
					>
						Save secret
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const RotateValue = ({ secret }: { secret: Secret }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [value, setValue] = useState("");
	const setSecret = api.vault.setValue.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={`New value for ${secret.name}`}
				>
					<RotateCw className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New value for {secret.name}</DialogTitle>
					<DialogDescription>
						Saved as version {secret.currentVersion + 1}. Services pick it up on
						their next deploy.
					</DialogDescription>
				</DialogHeader>
				<Textarea
					rows={3}
					spellCheck={false}
					value={value}
					onChange={(e) => setValue(e.target.value)}
				/>
				<DialogFooter>
					<Button
						isLoading={setSecret.isPending}
						onClick={async () => {
							await setSecret
								.mutateAsync({ id: secret.id, value })
								.then(async () => {
									toast.success("Value updated");
									await utils.vault.list.invalidate();
									setOpen(false);
									setValue("");
								})
								.catch(fail);
						}}
					>
						Save
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const Reveal = ({ secret }: { secret: Secret }) => {
	const [open, setOpen] = useState(false);
	const [password, setPassword] = useState("");
	const [value, setValue] = useState<string | null>(null);
	const reveal = api.vault.reveal.useMutation();
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				setValue(null);
				setPassword("");
			}}
		>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={`Reveal ${secret.name}`}
				>
					<Eye className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Reveal {secret.name}</DialogTitle>
					<DialogDescription>
						Confirm with your password. This is audited.
					</DialogDescription>
				</DialogHeader>
				{value === null ? (
					<Input
						type="password"
						autoComplete="current-password"
						value={password}
						placeholder="Your password"
						onChange={(e) => setPassword(e.target.value)}
					/>
				) : (
					<div className="flex items-start gap-2">
						<pre className="flex-1 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
							{value}
						</pre>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Copy"
							onClick={async () => {
								await navigator.clipboard.writeText(value);
								toast.success("Copied");
							}}
						>
							<Copy className="size-4" />
						</Button>
					</div>
				)}
				{value === null && (
					<DialogFooter>
						<Button
							isLoading={reveal.isPending}
							onClick={async () => {
								await reveal
									.mutateAsync({ id: secret.id, password })
									.then((r) => setValue(r.value))
									.catch(fail);
							}}
						>
							Reveal
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
};

const Versions = ({ secret }: { secret: Secret }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const { data } = api.vault.versions.useQuery(
		{ id: secret.id },
		{ enabled: open },
	);
	const restore = api.vault.restoreVersion.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					aria-label={`History of ${secret.name}`}
				>
					<History className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{secret.name}</DialogTitle>
					<DialogDescription>
						Versions, and where it was last used.
					</DialogDescription>
				</DialogHeader>
				<ul className="divide-y rounded-md border text-sm">
					{data?.versions.map((version) => (
						<li
							key={version.version}
							className="flex items-center gap-2 px-3 py-2"
						>
							<span className="font-medium">v{version.version}</span>
							<span className="text-xs text-muted-foreground">
								{formatDistanceToNow(new Date(version.createdAt), {
									addSuffix: true,
								})}
							</span>
							{version.version === secret.currentVersion ? (
								<Badge variant="green" className="ml-auto">
									current
								</Badge>
							) : (
								<Button
									variant="ghost"
									size="sm"
									className="ml-auto"
									onClick={async () => {
										await restore
											.mutateAsync({ id: secret.id, version: version.version })
											.then(async () => {
												toast.success(`Restored v${version.version}`);
												await utils.vault.invalidate();
											})
											.catch(fail);
									}}
								>
									Make current
								</Button>
							)}
						</li>
					))}
				</ul>
				<p className="text-xs text-muted-foreground">
					{data?.usages.length
						? `Used by ${data.usages.length} environment(s) at the last deploy.`
						: "Not used by any deploy yet."}
				</p>
			</DialogContent>
		</Dialog>
	);
};

const RecoveryKit = () => {
	const [open, setOpen] = useState(false);
	const [passphrase, setPassphrase] = useState("");
	const exportKit = api.vault.exportRecoveryKit.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<DownloadCloud className="size-4" />
					Recovery kit
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Download the recovery kit</DialogTitle>
					<DialogDescription>
						The master key, sealed with a passphrase. Without it, lost secrets
						stay lost — keep it off this server.
					</DialogDescription>
				</DialogHeader>
				<Input
					type="password"
					value={passphrase}
					placeholder="Passphrase (at least 12 characters)"
					onChange={(e) => setPassphrase(e.target.value)}
				/>
				<DialogFooter>
					<Button
						isLoading={exportKit.isPending}
						onClick={async () => {
							await exportKit
								.mutateAsync({ passphrase })
								.then((kit) => {
									const url = URL.createObjectURL(
										new Blob([JSON.stringify(kit, null, 2)], {
											type: "application/json",
										}),
									);
									const link = document.createElement("a");
									link.href = url;
									link.download = "dokploy-vault-recovery-kit.json";
									link.click();
									URL.revokeObjectURL(url);
									setOpen(false);
									setPassphrase("");
								})
								.catch(fail);
						}}
					>
						Download
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const RestoreKit = () => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [kit, setKit] = useState("");
	const [passphrase, setPassphrase] = useState("");
	const importKit = api.vault.importRecoveryKit.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Upload className="size-4" />
					Restore key
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Restore the master key</DialogTitle>
					<DialogDescription>
						Paste a recovery kit. Existing keys are kept.
					</DialogDescription>
				</DialogHeader>
				<Textarea
					rows={6}
					value={kit}
					spellCheck={false}
					placeholder="{ ... }"
					onChange={(e) => setKit(e.target.value)}
				/>
				<Input
					type="password"
					value={passphrase}
					placeholder="Passphrase"
					onChange={(e) => setPassphrase(e.target.value)}
				/>
				<DialogFooter>
					<Button
						isLoading={importKit.isPending}
						onClick={async () => {
							await importKit
								.mutateAsync({ kit, passphrase })
								.then(async (r) => {
									toast.success(`Restored ${r.keyIds.length} key(s)`);
									await utils.vault.invalidate();
									setOpen(false);
									setKit("");
									setPassphrase("");
								})
								.catch(fail);
						}}
					>
						Restore
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const CredentialEncryption = () => {
	const utils = api.useUtils();
	const { data: status } = api.vault.status.useQuery();
	const setEncryption = api.vault.setCredentialEncryption.useMutation();
	if (!status) return null;
	const on = status.credentialsEncrypted;
	return (
		<div className="flex flex-wrap items-center gap-3 rounded-md border p-4 text-sm">
			<div className="min-w-0 flex-1">
				<p className="font-medium">
					Encrypt stored credentials {on ? "" : "(off)"}
				</p>
				<p className="text-muted-foreground">
					SSH keys, S3 and registry credentials, git and notification tokens and
					database passwords. Reversible.
				</p>
			</div>
			<Button
				variant={on ? "outline" : "default"}
				isLoading={setEncryption.isPending}
				onClick={async () => {
					await setEncryption
						.mutateAsync({ enabled: !on })
						.then(async (r) => {
							toast.success(
								r.jobId
									? "Conversion started — follow it in Activity"
									: `Converted ${r.changed} value(s)`,
							);
							await utils.vault.status.invalidate();
						})
						.catch(fail);
				}}
			>
				{on ? "Turn off" : "Turn on"}
			</Button>
		</div>
	);
};

export const VaultSettings = () => {
	const utils = api.useUtils();
	const { data: me } = api.user.get.useQuery();
	const { data: status } = api.vault.status.useQuery();
	const isOwner = me?.role === "owner";
	const isAdmin = isOwner || me?.role === "admin";
	const { data: secrets } = api.vault.list.useQuery(undefined, {
		enabled: !!status?.enabled,
	});
	const setEnabled = api.vault.setEnabled.useMutation();
	const rotate = api.vault.rotateKey.useMutation();
	const remove = api.vault.remove.useMutation();

	return (
		<section className="flex flex-col gap-4">
			<PageHeader
				icon={<KeyRound className="size-5" />}
				title="Vault"
				description={
					<>
						Secrets used by name — <code>{"${{secret.NAME}}"}</code> — and read
						by no one.
					</>
				}
				actions={
					status?.enabled ? (
						<div className="flex flex-wrap gap-2">
							{isOwner && <RecoveryKit />}
							{isOwner && <RestoreKit />}
							{isOwner && (
								<Button
									variant="ghost"
									isLoading={rotate.isPending}
									onClick={async () => {
										await rotate
											.mutateAsync()
											.then((r) =>
												toast.success(
													`Rotated; ${r.rewrapped} value(s) rewrapped`,
												),
											)
											.catch(fail);
									}}
								>
									Rotate key
								</Button>
							)}
							<CreateSecret canUseOrganization={!!isAdmin} />
						</div>
					) : undefined
				}
			/>

			{!status?.enabled && (
				<div className="space-y-3 rounded-md border p-4 text-sm">
					<p className="font-medium">The vault is off</p>
					<p className="text-muted-foreground">
						Creates a master key on this server. Download the recovery kit
						afterwards and keep it elsewhere.
					</p>
					{isOwner ? (
						<Button
							isLoading={setEnabled.isPending}
							onClick={async () => {
								await setEnabled
									.mutateAsync({ enabled: true })
									.then(async () => {
										toast.success("Vault ready — download the recovery kit");
										await utils.vault.invalidate();
									})
									.catch(fail);
							}}
						>
							Turn on
						</Button>
					) : (
						<p className="text-muted-foreground">
							Ask the organization owner to turn it on.
						</p>
					)}
				</div>
			)}

			{isOwner && <CredentialEncryption />}

			{status?.enabled && !status.keyReady && (
				<div className="rounded-md border border-destructive/40 p-4 text-sm text-destructive">
					The master key is missing from this server. Restore it from your
					recovery kit; until then, deploys that use a secret will fail.
				</div>
			)}

			{status?.enabled && (
				<ul className="divide-y rounded-md border">
					{secrets?.length === 0 && (
						<li className="p-6 text-center text-sm text-muted-foreground">
							No secrets yet.
						</li>
					)}
					{secrets?.map((secret) => (
						<li
							key={secret.id}
							className="flex flex-wrap items-center gap-2 px-4 py-3"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<code className="font-medium">{secret.name}</code>
									<Badge variant="outline">{secret.scopeLabel}</Badge>
									<span className="text-xs text-muted-foreground">
										v{secret.currentVersion}
									</span>
								</div>
								<p className="truncate text-xs text-muted-foreground">
									{secret.description || "No description"}
									{secret.lastUsedAt
										? ` · used ${formatDistanceToNow(new Date(secret.lastUsedAt), { addSuffix: true })}`
										: " · never used"}
								</p>
							</div>
							<div className="flex items-center">
								<Versions secret={secret} />
								<RotateValue secret={secret} />
								{status.canReveal && <Reveal secret={secret} />}
								{isAdmin && (
									<DialogAction
										title={`Delete ${secret.name}?`}
										description="Deploys that still reference it will fail until the reference is removed."
										type="destructive"
										onClick={async () => {
											await remove
												.mutateAsync({ id: secret.id, force: true })
												.then(async () => {
													toast.success(`${secret.name} deleted`);
													await utils.vault.list.invalidate();
												})
												.catch(fail);
										}}
									>
										<Button
											variant="ghost"
											size="icon"
											className="text-destructive hover:text-destructive"
											aria-label={`Delete ${secret.name}`}
										>
											<Trash2 className="size-4" />
										</Button>
									</DialogAction>
								)}
							</div>
						</li>
					))}
				</ul>
			)}
		</section>
	);
};
