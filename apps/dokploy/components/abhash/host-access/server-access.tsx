import {
	Copy,
	KeyRound,
	Lock,
	LockOpen,
	Play,
	Plus,
	ShieldCheck,
	Trash2,
} from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { SectionHeader } from "@/components/shared/page-header";
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
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";

const fail = (error: { message: string }) => toast.error(error.message);

const LEVELS = [
	{
		id: "open",
		title: "Open",
		description:
			"Dokploy does not manage this server's firewall. Rules applied earlier stay until you change them.",
	},
	{
		id: "web",
		title: "Web only",
		description:
			"Only HTTP and HTTPS are public. SSH and everything else answer only on the secure network (or, without one, SSH is rate limited).",
	},
	{
		id: "private",
		title: "Private",
		description:
			"Nothing is public. The server is reachable only over the secure network, including its websites.",
	},
] as const;

const ExposureTab = ({ serverId }: { serverId: string }) => {
	const utils = api.useUtils();
	const { data, isPending, error } = api.hostAccess.exposure.useQuery({
		serverId,
	});
	const setExposure = api.hostAccess.setExposure.useMutation();
	const [choice, setChoice] = useState<string | null>(null);

	if (serverId === "local") {
		return (
			<p className="text-[13px] text-muted-foreground">
				The Dokploy host's own firewall is kept outside Dokploy so a mistake
				here can never cut off the panel itself. Users, rescue access and
				commands still work for it.
			</p>
		);
	}
	if (error) return <AlertBlock type="error">{error.message}</AlertBlock>;
	if (isPending || !data) {
		return <p className="text-[13px] text-muted-foreground">Loading…</p>;
	}
	const selected = choice ?? data.level;

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-2">
				{LEVELS.map((level) => (
					<button
						key={level.id}
						type="button"
						aria-pressed={selected === level.id}
						disabled={level.id === "private" && !data.hasMesh}
						onClick={() => setChoice(level.id)}
						className={cn(
							"flex flex-col gap-0.5 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50",
							selected === level.id && "bg-accent ring-1 ring-border",
						)}
					>
						<span className="flex items-center gap-2 text-sm font-medium">
							{level.title}
							{data.level === level.id && (
								<Badge variant="secondary" className="text-[10px]">
									current
								</Badge>
							)}
						</span>
						<span className="text-[13px] text-muted-foreground">
							{level.id === "private" && !data.hasMesh
								? "Connect this server to the secure network first (Settings → Secure network)."
								: level.description}
						</span>
					</button>
				))}
			</div>
			{data.lastError && (
				<AlertBlock type="warning">{data.lastError}</AlertBlock>
			)}
			<div className="flex items-center justify-between gap-3">
				<p className="text-xs text-muted-foreground">
					Applied with a two-minute safety net: if Dokploy cannot reach the
					server afterwards, it puts the old rules back by itself.
				</p>
				<Button
					disabled={selected === data.level}
					isLoading={setExposure.isPending}
					onClick={async () => {
						await setExposure
							.mutateAsync({
								serverId,
								level: selected as "open" | "web" | "private",
							})
							.then(async (result) => {
								toast.success(
									result.approvalId
										? "Waiting for approval"
										: result.jobId
											? "Applying; watch it under Activity"
											: "Saved",
								);
								setChoice(null);
								await utils.hostAccess.exposure.invalidate({ serverId });
							})
							.catch(fail);
					}}
				>
					Apply
				</Button>
			</div>
		</div>
	);
};

type HostUser = RouterOutputs["hostAccess"]["users"]["users"][number];

const KeysDialog = ({
	serverId,
	user,
	trigger,
	onDone,
}: {
	serverId: string;
	user?: HostUser;
	trigger: ReactNode;
	onDone: () => void;
}) => {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [keys, setKeys] = useState("");
	const [sudo, setSudo] = useState<"none" | "nopasswd">("none");
	const create = api.hostAccess.createUser.useMutation();
	const setUserKeys = api.hostAccess.setKeys.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{user ? `SSH keys for ${user.name}` : "Add a user"}
					</DialogTitle>
					<DialogDescription>
						{user
							? "Replaces every key this user can log in with."
							: "A login account on this server. It signs in with SSH keys only; no password is set."}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					{!user && (
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label>User name</Label>
								<Input
									value={name}
									placeholder="deploy"
									onChange={(event) =>
										setName(event.target.value.toLowerCase())
									}
								/>
							</div>
							<div className="flex flex-col gap-1.5">
								<Label>Admin rights</Label>
								<Select
									value={sudo}
									onValueChange={(value) => setSudo(value as typeof sudo)}
								>
									<SelectTrigger>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="none">None</SelectItem>
										<SelectItem value="nopasswd">
											sudo without a password
										</SelectItem>
									</SelectContent>
								</Select>
							</div>
						</div>
					)}
					<div className="flex flex-col gap-1.5">
						<Label>Public SSH keys, one per line</Label>
						<Textarea
							value={keys}
							rows={5}
							className="font-mono text-xs"
							placeholder="ssh-ed25519 AAAA… you@laptop"
							onChange={(event) => setKeys(event.target.value)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						isLoading={create.isPending || setUserKeys.isPending}
						disabled={!keys.trim() || (!user && !name.trim())}
						onClick={async () => {
							const done = user
								? setUserKeys.mutateAsync({
										serverId,
										name: user.name,
										publicKeys: keys,
									})
								: create.mutateAsync({
										serverId,
										name,
										publicKeys: keys,
										sudo,
									});
							await done
								.then(() => {
									toast.success(user ? "Keys replaced" : `${name} added`);
									setOpen(false);
									setName("");
									setKeys("");
									onDone();
								})
								.catch(fail);
						}}
					>
						{user ? "Replace keys" : "Add user"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const UsersTab = ({ serverId }: { serverId: string }) => {
	const utils = api.useUtils();
	const { data, isPending, error } = api.hostAccess.users.useQuery(
		{ serverId },
		{ retry: false },
	);
	const lock = api.hostAccess.lockUser.useMutation();
	const remove = api.hostAccess.deleteUser.useMutation();
	const [removeHome, setRemoveHome] = useState(false);
	const refresh = () => utils.hostAccess.users.invalidate({ serverId });

	if (error) return <AlertBlock type="error">{error.message}</AlertBlock>;
	return (
		<div className="flex flex-col gap-2">
			<SectionHeader
				title="Login accounts"
				description="People and services that can log in to this server."
				actions={
					<KeysDialog
						serverId={serverId}
						onDone={refresh}
						trigger={
							<Button size="sm" variant="outline">
								<Plus className="size-4" />
								Add user
							</Button>
						}
					/>
				}
			/>
			{isPending ? (
				<p className="py-3 text-[13px] text-muted-foreground">
					Reading accounts…
				</p>
			) : (
				<ul className="divide-y">
					{data?.users.map((user) => {
						const protectedUser =
							user.name === "root" || user.name === data.loginUser;
						return (
							<li key={user.name} className="flex items-center gap-3 py-2.5">
								<div className="flex min-w-0 flex-1 flex-col">
									<span className="flex flex-wrap items-center gap-1.5">
										<span className="font-mono text-[13px] font-medium">
											{user.name}
										</span>
										{user.admin && (
											<Badge variant="secondary" className="text-[10px]">
												admin
											</Badge>
										)}
										{user.locked && (
											<Badge variant="orange" className="text-[10px]">
												locked
											</Badge>
										)}
										{user.name === data.loginUser && (
											<Badge variant="secondary" className="text-[10px]">
												Dokploy logs in as this
											</Badge>
										)}
									</span>
									<span className="text-xs text-muted-foreground">
										{user.keys} key{user.keys === 1 ? "" : "s"} · {user.shell}
									</span>
								</div>
								<KeysDialog
									serverId={serverId}
									user={user}
									onDone={refresh}
									trigger={
										<Button
											variant="ghost"
											size="icon"
											className="size-8 text-muted-foreground"
											aria-label={`SSH keys for ${user.name}`}
										>
											<KeyRound className="size-4" />
										</Button>
									}
								/>
								<Button
									variant="ghost"
									size="icon"
									className="size-8 text-muted-foreground"
									disabled={protectedUser && !user.locked}
									aria-label={
										user.locked ? `Unlock ${user.name}` : `Lock ${user.name}`
									}
									title={
										protectedUser
											? "Dokploy needs this account"
											: user.locked
												? "Unlock"
												: "Lock: blocks every login, keys included"
									}
									onClick={async () => {
										await lock
											.mutateAsync({
												serverId,
												name: user.name,
												locked: !user.locked,
											})
											.then(refresh)
											.catch(fail);
									}}
								>
									{user.locked ? (
										<LockOpen className="size-4" />
									) : (
										<Lock className="size-4" />
									)}
								</Button>
								<DialogAction
									title={`Delete ${user.name}?`}
									description={
										<span className="flex flex-col gap-3">
											<span>
												Their running processes stop and they can no longer log
												in.
											</span>
											<span className="flex items-center gap-2">
												<Checkbox
													id="remove-home"
													checked={removeHome}
													onCheckedChange={(value) =>
														setRemoveHome(value === true)
													}
												/>
												<Label htmlFor="remove-home">
													Also delete their home folder
												</Label>
											</span>
										</span>
									}
									disabled={protectedUser}
									onClick={async () => {
										await remove
											.mutateAsync({ serverId, name: user.name, removeHome })
											.then(() => {
												toast.success(`${user.name} deleted`);
												refresh();
											})
											.catch(fail);
									}}
								>
									<Button
										variant="ghost"
										size="icon"
										className="size-8 text-muted-foreground hover:text-destructive"
										disabled={protectedUser}
										aria-label={`Delete ${user.name}`}
									>
										<Trash2 className="size-4" />
									</Button>
								</DialogAction>
							</li>
						);
					})}
				</ul>
			)}
		</div>
	);
};

const Secret = ({ label, value }: { label: string; value: string }) => (
	<div className="flex flex-col gap-1.5 rounded-lg bg-muted/60 p-3">
		<span className="text-xs text-muted-foreground">{label}</span>
		<div className="flex items-center gap-2">
			<code className="flex-1 break-all font-mono text-sm">{value}</code>
			<Button
				variant="ghost"
				size="icon"
				className="size-8"
				aria-label="Copy"
				onClick={async () => {
					await navigator.clipboard.writeText(value).catch(() => undefined);
					toast.success("Copied");
				}}
			>
				<Copy className="size-4" />
			</Button>
		</div>
		<span className="text-xs text-muted-foreground">
			Shown once. Dokploy does not keep it; store it in your password manager.
		</span>
	</div>
);

const RescueTab = ({ serverId }: { serverId: string }) => {
	const utils = api.useUtils();
	const { data, isPending, error } = api.hostAccess.rescue.useQuery(
		{ serverId },
		{ retry: false },
	);
	const enable = api.hostAccess.enableRescue.useMutation();
	const rotate = api.hostAccess.rotateRescue.useMutation();
	const disable = api.hostAccess.disableRescue.useMutation();
	const [port, setPort] = useState("2299");
	const [revealed, setRevealed] = useState<string | null>(null);
	const refresh = () => utils.hostAccess.rescue.invalidate({ serverId });

	if (error) return <AlertBlock type="error">{error.message}</AlertBlock>;
	if (isPending || !data) {
		return <p className="text-[13px] text-muted-foreground">Checking…</p>;
	}
	const active = !!data.port;

	return (
		<div className="flex flex-col gap-4">
			<p className="text-[13px] text-muted-foreground">
				A password login for one user, <code>rescue</code>, on its own port. It
				works when keys, the secure network or Dokploy itself are not available,
				and only for that user on that port.
			</p>
			{revealed && <Secret label="Rescue password" value={revealed} />}
			{active ? (
				<div className="flex flex-col gap-3">
					<div className="flex items-center gap-2 text-sm">
						<ShieldCheck className="size-4 text-status-running" />
						Rescue login is on, port{" "}
						<span className="font-mono">{data.port}</span>
						{!data.managed && (
							<Badge variant="secondary" className="text-[10px]">
								set up outside Dokploy
							</Badge>
						)}
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							variant="outline"
							size="sm"
							isLoading={rotate.isPending}
							onClick={async () => {
								await rotate
									.mutateAsync({ serverId })
									.then((result) => setRevealed(result.password))
									.catch(fail);
							}}
						>
							New password
						</Button>
						{data.managed && (
							<DialogAction
								title="Turn the rescue login off?"
								description="SSH restarts. If Dokploy cannot log in again afterwards, the server restores the rescue login within three minutes."
								onClick={async () => {
									await disable
										.mutateAsync({ serverId })
										.then(() => {
											toast.success("Rescue login removed");
											setRevealed(null);
											refresh();
										})
										.catch(fail);
								}}
							>
								<Button variant="ghost" size="sm" className="text-destructive">
									Turn off
								</Button>
							</DialogAction>
						)}
					</div>
				</div>
			) : (
				<div className="flex items-end gap-3">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="rescue-port">Port</Label>
						<div className="w-28">
							<Input
								id="rescue-port"
								inputMode="numeric"
								value={port}
								onChange={(event) => setPort(event.target.value)}
							/>
						</div>
					</div>
					<DialogAction
						type="default"
						title="Turn the rescue login on?"
						description={`SSH restarts with port ${port} added. If Dokploy cannot log in again afterwards, the server undoes the change within three minutes. If this server has a cloud firewall, open port ${port} there too.`}
						onClick={async () => {
							await enable
								.mutateAsync({ serverId, port: Number(port) })
								.then((result) => {
									setRevealed(result.password);
									toast.success(`Rescue login on port ${result.port}`);
									refresh();
								})
								.catch(fail);
						}}
					>
						<Button isLoading={enable.isPending}>Turn on</Button>
					</DialogAction>
				</div>
			)}
		</div>
	);
};

const RISK_LABEL = {
	read: null,
	change: "changes things",
	danger: "interrupts the server",
} as const;

const CommandsTab = ({ serverId }: { serverId: string }) => {
	const { data: commands } = api.hostAccess.commands.useQuery();
	const run = api.hostAccess.runCommand.useMutation();
	const [output, setOutput] = useState<{
		label: string;
		text: string;
		code: number;
	} | null>(null);
	const [running, setRunning] = useState<string | null>(null);

	const execute = async (id: string, label: string) => {
		setRunning(id);
		await run
			.mutateAsync({ serverId, commandId: id })
			.then((result) =>
				setOutput({ label, text: result.output, code: result.code }),
			)
			.catch(fail)
			.finally(() => setRunning(null));
	};

	return (
		<div className="flex flex-col gap-3">
			{output && (
				<div className="flex flex-col gap-1.5">
					<span className="text-xs text-muted-foreground">
						{output.label}
						{output.code !== 0 && ` · exited with ${output.code}`}
					</span>
					<pre className="max-h-80 overflow-auto rounded-lg bg-[#070708] p-3 font-mono text-xs text-slate-200">
						{output.text || "(no output)"}
					</pre>
				</div>
			)}
			<ul className="divide-y">
				{commands?.map((command) => {
					const button = (
						<Button
							variant="ghost"
							size="icon"
							className="size-8 text-muted-foreground"
							isLoading={running === command.id}
							aria-label={`Run ${command.label}`}
							onClick={
								command.risk === "read"
									? () => execute(command.id, command.label)
									: undefined
							}
						>
							<Play className="size-4" />
						</Button>
					);
					return (
						<li key={command.id} className="flex items-center gap-3 py-2">
							<div className="flex min-w-0 flex-1 flex-col">
								<span className="flex items-center gap-2 text-sm font-medium">
									{command.label}
									{RISK_LABEL[command.risk] && (
										<span
											className={cn(
												"text-[11px] font-normal",
												command.risk === "danger"
													? "text-status-failed"
													: "text-status-restarting",
											)}
										>
											{RISK_LABEL[command.risk]}
										</span>
									)}
								</span>
								<span className="text-xs text-muted-foreground">
									{command.description}
								</span>
							</div>
							{command.risk === "read" ? (
								button
							) : (
								<DialogAction
									type={command.risk === "danger" ? "destructive" : "default"}
									title={`${command.label}?`}
									description={command.description}
									onClick={() => execute(command.id, command.label)}
								>
									{button}
								</DialogAction>
							)}
						</li>
					);
				})}
			</ul>
		</div>
	);
};

export const ServerAccess = ({
	serverId,
	serverName,
	children,
}: {
	serverId: string;
	serverName: string;
	children: ReactNode;
}) => (
	<Sheet>
		<SheetTrigger asChild>{children}</SheetTrigger>
		<SheetContent className="w-full gap-0 overflow-y-auto data-[side=right]:sm:max-w-xl">
			<SheetHeader className="pb-2">
				<SheetTitle>Access · {serverName}</SheetTitle>
				<SheetDescription>
					Who and what can reach this server, and the tools to get back in.
				</SheetDescription>
			</SheetHeader>
			<Tabs defaultValue="exposure" className="gap-5 px-6 pb-6">
				<TabsList>
					<TabsTrigger value="exposure">Exposure</TabsTrigger>
					<TabsTrigger value="users">Users</TabsTrigger>
					<TabsTrigger value="rescue">Rescue</TabsTrigger>
					<TabsTrigger value="commands">Commands</TabsTrigger>
				</TabsList>
				<TabsContent value="exposure">
					<ExposureTab serverId={serverId} />
				</TabsContent>
				<TabsContent value="users">
					<UsersTab serverId={serverId} />
				</TabsContent>
				<TabsContent value="rescue">
					<RescueTab serverId={serverId} />
				</TabsContent>
				<TabsContent value="commands">
					<CommandsTab serverId={serverId} />
				</TabsContent>
			</Tabs>
		</SheetContent>
	</Sheet>
);
