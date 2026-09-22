import { formatDistanceToNow } from "date-fns";
import {
	AlertTriangle,
	Brush,
	Play,
	RefreshCw,
	ServerCog,
	ShieldAlert,
	Terminal,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { InfoTooltip } from "@/components/shared/info-tooltip";
import { PageHeader } from "@/components/shared/page-header";
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
import { Textarea } from "@/components/ui/textarea";
import { api, type RouterOutputs } from "@/utils/api";

type Fleet = RouterOutputs["fleet"]["list"];
type Row = Fleet["servers"][number];
type Health = NonNullable<Row["meta"]>["health"];

const fail = (error: Error) => toast.error(error.message);

const HEALTH: Record<
	Health,
	{ label: string; variant: "green" | "yellow" | "red" | "outline" }
> = {
	online: { label: "online", variant: "green" },
	degraded: { label: "degraded", variant: "yellow" },
	offline: { label: "offline", variant: "red" },
	unknown: { label: "unknown", variant: "outline" },
};

/** Commands that can take a server out, typed out to confirm. */
const DANGEROUS =
	/\b(rm\s+-rf\s+\/(?!\w)|mkfs|dd\s+if=|shutdown|reboot|halt|iptables\s+-F|ufw\s+--force\s+reset|docker\s+system\s+prune\s+-a)/;

const RunCommand = ({
	servers,
	selected,
}: {
	servers: Row[];
	selected: string[];
}) => {
	const [open, setOpen] = useState(false);
	const [command, setCommand] = useState("");
	const [mode, setMode] = useState<"parallel" | "rolling" | "serial">(
		"rolling",
	);
	const [batchSize, setBatchSize] = useState("5");
	const [stopOnFailure, setStopOnFailure] = useState(true);
	const [confirm, setConfirm] = useState("");
	const run = api.fleet.run.useMutation();
	const dangerous = DANGEROUS.test(command);
	const names = servers
		.filter((server) => selected.includes(server.serverId))
		.map((server) => server.name);

	return (
		<>
			<Button disabled={selected.length === 0} onClick={() => setOpen(true)}>
				<Terminal className="size-4" />
				Run command
			</Button>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent className="sm:max-w-2xl">
					<DialogHeader>
						<DialogTitle>Run on {selected.length} server(s)</DialogTitle>
						<DialogDescription className="truncate">
							{names.join(", ")}
						</DialogDescription>
					</DialogHeader>
					<Textarea
						rows={5}
						spellCheck={false}
						className="font-mono text-xs"
						placeholder="docker ps"
						value={command}
						onChange={(event) => setCommand(event.target.value)}
					/>
					<div className="grid gap-3 sm:grid-cols-3">
						<div className="flex flex-col gap-1.5">
							<Label>How</Label>
							<Select
								value={mode}
								onValueChange={(value) =>
									setMode(value as "parallel" | "rolling" | "serial")
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="rolling">In batches</SelectItem>
									<SelectItem value="serial">One at a time</SelectItem>
									<SelectItem value="parallel">All at once</SelectItem>
								</SelectContent>
							</Select>
						</div>
						{mode === "rolling" && (
							<div className="flex flex-col gap-1.5">
								<Label>Batch size</Label>
								<Input
									value={batchSize}
									inputMode="numeric"
									onChange={(event) => setBatchSize(event.target.value)}
								/>
							</div>
						)}
						<div className="flex items-end justify-between gap-2 rounded-md border p-3">
							<span className="text-sm">Stop on first failure</span>
							<Switch
								checked={stopOnFailure}
								onCheckedChange={setStopOnFailure}
							/>
						</div>
					</div>
					{dangerous && (
						<div className="flex flex-col gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
							<span className="flex items-center gap-2">
								<AlertTriangle className="size-4" />
								This can destroy data. Type {selected.length} to confirm.
							</span>
							<Input
								value={confirm}
								placeholder={String(selected.length)}
								onChange={(event) => setConfirm(event.target.value)}
							/>
						</div>
					)}
					<DialogFooter>
						<Button
							isLoading={run.isPending}
							disabled={
								!command || (dangerous && confirm !== String(selected.length))
							}
							onClick={async () => {
								await run
									.mutateAsync({
										action: "exec",
										serverIds: selected,
										command,
										mode,
										batchSize: Number(batchSize) || 5,
										stopOnFailure,
									})
									.then((result) => {
										toast.success(
											result.approvalId
												? "Waiting for approval"
												: "Running — follow it in Activity",
										);
										setOpen(false);
										setCommand("");
										setConfirm("");
									})
									.catch(fail);
							}}
						>
							<Play className="size-4" />
							Run
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
};

export const CommandCenter = () => {
	const utils = api.useUtils();
	const { data } = api.fleet.list.useQuery(undefined, {
		refetchInterval: 30_000,
	});
	const [selected, setSelected] = useState<string[]>([]);
	const [filter, setFilter] = useState("");
	const run = api.fleet.run.useMutation();
	const refresh = api.fleet.refresh.useMutation();
	const acceptKey = api.fleet.acceptHostKey.useMutation();

	const servers = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		return (data?.servers ?? []).filter((server) =>
			needle
				? [server.name, server.ipAddress, ...(server.meta?.tags ?? [])]
						.join(" ")
						.toLowerCase()
						.includes(needle)
				: true,
		);
	}, [data, filter]);

	const act = async (
		action: "patch" | "cleanup",
		extra: Record<string, unknown> = {},
	) => {
		await run
			.mutateAsync({ action, serverIds: selected, ...extra } as never)
			.then((result) =>
				toast.success(
					result.approvalId
						? "Waiting for approval"
						: "Started — follow it in Activity",
				),
			)
			.catch(fail);
	};

	return (
		<section className="flex flex-col gap-4">
			<PageHeader
				icon={<ServerCog className="size-5" />}
				title={
					<span className="flex items-center gap-2">
						Command centre
						<InfoTooltip
							content={
								<span>
									Every server registered in this organization. The machine
									Dokploy itself runs on is not one of them until you add it:
									Dokploy runs in a container, so it reaches a server over SSH,
									including this one. Add it under Settings → Servers and it
									gets baselines, patching and cron here like the rest.
								</span>
							}
						/>
					</span>
				}
				description="Health, tags and actions for every server."
				actions={
					<div className="flex items-center gap-2">
						<Input
							value={filter}
							placeholder="Filter servers"
							className="w-40"
							onChange={(event) => setFilter(event.target.value)}
						/>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Refresh"
							isLoading={refresh.isPending}
							onClick={async () => {
								await refresh
									.mutateAsync({})
									.then(async () => {
										await utils.fleet.list.invalidate();
									})
									.catch(fail);
							}}
						>
							<RefreshCw className="size-4" />
						</Button>
						<RunCommand servers={servers} selected={selected} />
					</div>
				}
			/>

			{/* Bulk actions appear only once something is selected. */}
			{selected.length > 0 && (
				<div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm">
					<span>{selected.length} selected</span>
					<Button variant="ghost" size="sm" onClick={() => setSelected([])}>
						Clear
					</Button>
					<div className="ml-auto flex gap-2">
						<Button variant="outline" size="sm" onClick={() => act("cleanup")}>
							<Brush className="size-4" />
							Reclaim disk
						</Button>
						<Button
							variant="outline"
							size="sm"
							onClick={() => act("patch", { batchSize: 1, reboot: true })}
						>
							Patch
						</Button>
					</div>
				</div>
			)}

			<ul className="divide-y rounded-md border">
				{servers.length === 0 && (
					<li className="p-6 text-center text-sm text-muted-foreground">
						No servers yet.
					</li>
				)}
				{servers.map((server) => {
					const meta = server.meta;
					const health = HEALTH[meta?.health ?? "unknown"];
					const facts = meta?.facts;
					return (
						<li
							key={server.serverId}
							className="flex flex-wrap items-center gap-3 px-4 py-3"
						>
							<Checkbox
								checked={selected.includes(server.serverId)}
								onCheckedChange={(checked) =>
									setSelected(
										checked
											? [...selected, server.serverId]
											: selected.filter((id) => id !== server.serverId),
									)
								}
								aria-label={`Select ${server.name}`}
							/>
							<div className="min-w-0 flex-1">
								<div className="flex flex-wrap items-center gap-2">
									<span className="font-medium">{server.name}</span>
									<Badge variant={health.variant}>{health.label}</Badge>
									{meta?.environmentLabel && (
										<Badge variant="outline">{meta.environmentLabel}</Badge>
									)}
									{meta?.maintenance && (
										<Badge variant="orange">maintenance</Badge>
									)}
									{meta?.hostKeyMismatch && (
										<Badge variant="red">
											<ShieldAlert className="mr-1 size-3" />
											host key changed
										</Badge>
									)}
									{meta?.tags.map((tag) => (
										<Badge key={tag} variant="secondary">
											{tag}
										</Badge>
									))}
								</div>
								<p className="truncate text-xs text-muted-foreground">
									{server.username}@{server.ipAddress}:{server.port}
									{facts?.os ? ` · ${facts.os}` : ""}
									{facts?.dockerVersion
										? ` · docker ${facts.dockerVersion}`
										: ""}
									{facts?.diskUsedPercent != null
										? ` · disk ${facts.diskUsedPercent}%`
										: ""}
									{meta?.lastSeenAt
										? ` · seen ${formatDistanceToNow(new Date(meta.lastSeenAt), { addSuffix: true })}`
										: " · never reached"}
									{meta?.healthMessage ? ` · ${meta.healthMessage}` : ""}
								</p>
							</div>
							{meta?.hostKeyMismatch && (
								<Button
									variant="outline"
									size="sm"
									onClick={async () => {
										await acceptKey
											.mutateAsync({ serverId: server.serverId })
											.then(async () => {
												toast.success("New host key accepted");
												await utils.fleet.list.invalidate();
											})
											.catch(fail);
									}}
								>
									Accept new key
								</Button>
							)}
							<Button
								variant="ghost"
								size="sm"
								onClick={async () => {
									await run
										.mutateAsync({
											action: "bootstrap",
											serverId: server.serverId,
											baseline: true,
											hardenSsh: true,
											installDocker: false,
										})
										.then((result) =>
											toast.success(
												result.approvalId
													? "Waiting for approval"
													: "Applying the baseline — follow it in Activity",
											),
										)
										.catch(fail);
								}}
							>
								Apply baseline
							</Button>
						</li>
					);
				})}
			</ul>
		</section>
	);
};
