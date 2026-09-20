import { formatDistanceToNow } from "date-fns";
import { Network, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { MeshIcon } from "@/components/icons/abhash/mesh-icons";
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
import { Switch } from "@/components/ui/switch";
import { api, type RouterOutputs } from "@/utils/api";

type Provider = RouterOutputs["mesh"]["list"]["providers"][number];
type Kind = "netbird" | "headscale";

const fail = (error: Error) => toast.error(error.message);

const KIND_LABEL: Record<Kind, string> = {
	netbird: "NetBird (self-hosted)",
	headscale: "Tailscale client with Headscale",
};

const EditProvider = ({ provider }: { provider?: Provider }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<Kind>(provider?.kind ?? "netbird");
	const [name, setName] = useState(provider?.name ?? "NetBird");
	const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
	const [tokenRef, setTokenRef] = useState(
		provider?.tokenRef ?? "${{secret.NETBIRD_TOKEN}}",
	);
	const [groupPrefix, setGroupPrefix] = useState(
		provider?.settings.groupPrefix ?? "dokploy",
	);
	const [manageDns, setManageDns] = useState(
		provider?.settings.manageDns ?? false,
	);
	const [swarmOverMesh, setSwarmOverMesh] = useState(
		provider?.settings.swarmOverMesh ?? false,
	);
	const [sshPort, setSshPort] = useState(
		String(provider?.settings.sshPort ?? 22),
	);
	const save = api.mesh.save.useMutation();

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{provider ? (
					<Button variant="ghost" size="sm">
						Edit
					</Button>
				) : (
					<Button>
						<Plus className="size-4" />
						Add provider
					</Button>
				)}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>
						{provider ? `Edit ${provider.name}` : "Add a mesh provider"}
					</DialogTitle>
					<DialogDescription>
						Only objects named with the prefix below are managed.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label>Provider</Label>
							<Select
								value={kind}
								onValueChange={(value) => setKind(value as Kind)}
								disabled={!!provider}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="netbird">{KIND_LABEL.netbird}</SelectItem>
									<SelectItem value="headscale">
										{KIND_LABEL.headscale}
									</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Name</Label>
							<Input
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>
							{kind === "netbird" ? "Management URL" : "Headscale URL"}
						</Label>
						<Input
							value={baseUrl}
							placeholder="https://netbird.example.com"
							onChange={(event) => setBaseUrl(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>API token (a vault secret)</Label>
						<Input
							value={tokenRef}
							onChange={(event) => setTokenRef(event.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							Only the name is stored here.
						</p>
					</div>
					<div className="grid gap-3 sm:grid-cols-2">
						<div className="flex flex-col gap-1.5">
							<Label>Name prefix</Label>
							<Input
								value={groupPrefix}
								onChange={(event) => setGroupPrefix(event.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>SSH port</Label>
							<Input
								value={sshPort}
								inputMode="numeric"
								onChange={(event) => setSshPort(event.target.value)}
							/>
						</div>
					</div>
					<div className="flex items-center justify-between rounded-md border p-3">
						<div>
							<p className="text-sm font-medium">Let the mesh manage DNS</p>
							<p className="text-xs text-muted-foreground">
								Off keeps your servers' container DNS untouched.
							</p>
						</div>
						<Switch checked={manageDns} onCheckedChange={setManageDns} />
					</div>
					<div className="flex items-center justify-between rounded-md border p-3">
						<div>
							<p className="text-sm font-medium">Swarm over the mesh</p>
							<p className="text-xs text-muted-foreground">
								Opens the Swarm ports between servers.
							</p>
						</div>
						<Switch
							checked={swarmOverMesh}
							onCheckedChange={setSwarmOverMesh}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						isLoading={save.isPending}
						onClick={async () => {
							await save
								.mutateAsync({
									id: provider?.id,
									kind,
									name,
									baseUrl,
									tokenRef,
									settings: {
										groupPrefix,
										manageDns,
										swarmOverMesh,
										sshPort: Number(sshPort) || 22,
									},
								})
								.then(async () => {
									toast.success("Saved");
									await utils.mesh.list.invalidate();
									setOpen(false);
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

/**
 * A fleet joined to NetBird or Tailscale by hand leaves no trace in Dokploy,
 * so the provider list is empty and the page looks like nothing is set up.
 * This reads the client on each server instead of asking a provider API.
 */
const DetectedMesh = () => {
	const [open, setOpen] = useState(false);
	const { data, isFetching, refetch } = api.mesh.detect.useQuery(undefined, {
		enabled: open,
		refetchOnWindowFocus: false,
	});

	const found = data?.filter((row) => row.kind) ?? [];

	return (
		<div className="flex flex-col gap-3 rounded-md border border-dashed p-4">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="min-w-0">
					<p className="font-medium">Already on a mesh?</p>
					<p className="text-sm text-muted-foreground">
						Check what each server is running, without changing anything.
					</p>
				</div>
				<Button
					variant="outline"
					size="sm"
					isLoading={isFetching}
					onClick={() => (open ? refetch() : setOpen(true))}
				>
					<Search className="size-4" />
					{open ? "Scan again" : "Scan servers"}
				</Button>
			</div>

			{open && !isFetching && data && (
				<>
					<p className="text-sm text-muted-foreground">
						{found.length === 0
							? "No mesh client found on any server."
							: `Found a client on ${found.length} of ${data.length} servers. Add the matching provider above to manage them here.`}
					</p>
					<ul className="divide-y rounded-md border">
						{data.map((row) => (
							<li
								key={row.serverId}
								className="flex flex-wrap items-center gap-2 px-3 py-2"
							>
								<div className="min-w-0 flex-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">{row.name}</span>
										{row.kind ? (
											<Badge variant="green">{KIND_LABEL[row.kind]}</Badge>
										) : row.error ? (
											<Badge variant="red">unreachable</Badge>
										) : (
											<Badge variant="outline">no client</Badge>
										)}
										{row.tracked && <Badge variant="secondary">tracked</Badge>}
										{row.connectedOverMesh && (
											<Badge variant="blue">Dokploy connects over it</Badge>
										)}
									</div>
									<p className="truncate text-xs text-muted-foreground">
										{row.error ??
											[row.meshIp ?? row.ipAddress, row.clientVersion]
												.filter(Boolean)
												.join(" · ")}
									</p>
								</div>
							</li>
						))}
					</ul>
				</>
			)}
		</div>
	);
};

export const MeshSettings = () => {
	const utils = api.useUtils();
	const { data } = api.mesh.list.useQuery();
	const setActive = api.mesh.setActive.useMutation();
	const test = api.mesh.test.useMutation();
	const plan = api.mesh.plan.useMutation();
	const sync = api.mesh.sync.useMutation();
	const join = api.mesh.join.useMutation();
	const leave = api.mesh.leave.useMutation();
	const remove = api.mesh.remove.useMutation();
	const [preview, setPreview] = useState<string | null>(null);

	const active = data?.providers.find((provider) => provider.active);

	return (
		<section className="flex flex-col gap-4">
			<PageHeader
				icon={<Network className="size-5" />}
				title="Secure network"
				description="One private network for your servers. One provider at a time."
				actions={
					<div className="flex gap-2">
						{active && (
							<Button
								variant="ghost"
								isLoading={sync.isPending}
								onClick={async () => {
									await sync
										.mutateAsync()
										.then(async (result) => {
											toast.success(`${result.matched} peers matched`);
											await utils.mesh.list.invalidate();
										})
										.catch(fail);
								}}
							>
								<RefreshCw className="size-4" />
								Sync
							</Button>
						)}
						<EditProvider />
					</div>
				}
			/>

			<div className="grid gap-3 sm:grid-cols-2">
				{data?.providers.map((provider) => (
					<div
						key={provider.id}
						className={`flex flex-col gap-2 rounded-md border p-4 ${provider.active ? "border-primary" : ""}`}
					>
						<div className="flex items-center gap-2">
							<MeshIcon kind={provider.kind} className="size-5" />
							<span className="font-medium">{provider.name}</span>
							{provider.active ? (
								<Badge variant="green">active</Badge>
							) : (
								<Badge variant="outline">inactive</Badge>
							)}
						</div>
						<p className="truncate text-xs text-muted-foreground">
							{KIND_LABEL[provider.kind]} · {provider.baseUrl}
							{provider.lastSyncAt
								? ` · synced ${formatDistanceToNow(new Date(provider.lastSyncAt), { addSuffix: true })}`
								: ""}
						</p>
						<div className="flex flex-wrap gap-2">
							<Button
								variant="outline"
								size="sm"
								isLoading={test.isPending}
								onClick={async () => {
									await test
										.mutateAsync({ id: provider.id })
										.then((result) => toast.success(result.detail))
										.catch(fail);
								}}
							>
								Test
							</Button>
							<Button
								variant="outline"
								size="sm"
								isLoading={plan.isPending}
								onClick={async () => {
									await plan
										.mutateAsync({ id: provider.id })
										.then((result) =>
											setPreview(
												[
													result.plan.create.length
														? `Would create:\n  ${result.plan.create.join("\n  ")}`
														: "Nothing to create.",
													result.plan.keep.length
														? `Already there:\n  ${result.plan.keep.join("\n  ")}`
														: "",
													result.snippet
														? `Paste this into your Headscale policy:\n${result.snippet}`
														: "",
												]
													.filter(Boolean)
													.join("\n\n"),
											),
										)
										.catch(fail);
								}}
							>
								Preview changes
							</Button>
							{!provider.active && (
								<Button
									size="sm"
									onClick={async () => {
										await setActive
											.mutateAsync({ id: provider.id })
											.then(async () => {
												toast.success(
													`${provider.name} is now the active mesh`,
												);
												await utils.mesh.list.invalidate();
											})
											.catch(fail);
									}}
								>
									Use this one
								</Button>
							)}
							{provider.active && (
								<Button
									variant="ghost"
									size="sm"
									onClick={async () => {
										await setActive
											.mutateAsync({ id: null })
											.then(async () => {
												toast.success("No mesh is active now");
												await utils.mesh.list.invalidate();
											})
											.catch(fail);
									}}
								>
									Turn off
								</Button>
							)}
							<EditProvider provider={provider} />
							<DialogAction
								title={`Delete ${provider.name}?`}
								description="Servers stay in the mesh; Dokploy just stops managing it."
								type="destructive"
								onClick={async () => {
									await remove
										.mutateAsync({ id: provider.id })
										.then(async () => {
											toast.success("Deleted");
											await utils.mesh.list.invalidate();
										})
										.catch(fail);
								}}
							>
								<Button
									variant="ghost"
									size="icon"
									className="text-destructive hover:text-destructive"
									aria-label={`Delete ${provider.name}`}
								>
									<Trash2 className="size-4" />
								</Button>
							</DialogAction>
						</div>
					</div>
				))}
			</div>

			{preview && (
				<pre className="overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
					{preview}
				</pre>
			)}

			{!active && <DetectedMesh />}

			{active && (
				<ul className="divide-y rounded-md border">
					{data?.servers.map((row) => (
						<li
							key={row.serverId}
							className="flex flex-wrap items-center gap-2 px-4 py-3"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="font-medium">{row.name}</span>
									{row.mesh ? (
										<Badge
											variant={
												row.mesh.status === "connected" ? "green" : "yellow"
											}
										>
											{row.mesh.status}
										</Badge>
									) : (
										<Badge variant="outline">not in the mesh</Badge>
									)}
									{row.mesh?.adopted && (
										<Badge variant="secondary">adopted</Badge>
									)}
								</div>
								<p className="truncate text-xs text-muted-foreground">
									{row.mesh?.meshIp
										? `${row.mesh.meshIp} · ${row.mesh.meshHostname}`
										: row.ipAddress}
									{row.mesh?.clientVersion
										? ` · client ${row.mesh.clientVersion}`
										: ""}
								</p>
							</div>
							{row.mesh ? (
								<Button
									variant="outline"
									size="sm"
									onClick={async () => {
										await leave
											.mutateAsync({ serverId: row.serverId })
											.then((result) =>
												toast.success(
													result.approvalId
														? "Waiting for approval"
														: "Leaving — follow it in Activity",
												),
											)
											.catch(fail);
									}}
								>
									Leave
								</Button>
							) : (
								<Button
									size="sm"
									onClick={async () => {
										await join
											.mutateAsync({ serverId: row.serverId, useForSsh: true })
											.then((result) =>
												toast.success(
													result.approvalId
														? "Waiting for approval"
														: "Joining — follow it in Activity",
												),
											)
											.catch(fail);
									}}
								>
									Join
								</Button>
							)}
						</li>
					))}
				</ul>
			)}
		</section>
	);
};
