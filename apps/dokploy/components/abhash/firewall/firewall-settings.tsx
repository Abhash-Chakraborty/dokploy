import { AlertTriangle, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { api, type RouterOutputs } from "@/utils/api";

type List = RouterOutputs["firewall"]["list"];
type ServerRow = List["servers"][number];
type Mode = "off" | "audit" | "enforce";

const fail = (error: Error) => toast.error(error.message);

const MODE_HELP: Record<Mode, string> = {
	off: "Dokploy does not touch this server's firewall.",
	audit: "Rules are worked out and shown, but never applied.",
	enforce: "Dokploy applies the rules, with an automatic rollback.",
};

const Plan = ({ server }: { server: ServerRow }) => {
	const [open, setOpen] = useState(false);
	const { data } = api.firewall.plan.useQuery(
		{ serverId: server.serverId },
		{ enabled: open },
	);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					Preview rules
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>{server.name}</DialogTitle>
					<DialogDescription>
						What would be applied, and why each rule is there. Automatic rules
						come from what is deployed here; you can switch any of them off.
					</DialogDescription>
				</DialogHeader>
				{data?.lockout && (
					<div className="flex items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
						<AlertTriangle className="size-4 shrink-0" />
						{data.lockout} — Dokploy refuses to apply this.
					</div>
				)}
				<ul className="max-h-72 divide-y overflow-auto rounded-md border text-sm">
					{data?.rules.map((rule) => (
						<li
							key={`${rule.origin}-${rule.port}-${rule.protocol}`}
							className="flex items-center gap-2 px-3 py-2"
						>
							<Badge
								variant={rule.action === "allow" ? "green" : "yellow"}
								className="uppercase"
							>
								{rule.action}
							</Badge>
							<code className="text-xs">
								{rule.protocol}/{rule.port}
							</code>
							<span className="text-xs text-muted-foreground">
								from {rule.from}
							</span>
							<span className="ml-auto text-xs text-muted-foreground">
								{rule.comment}
								{rule.chain === "docker" ? " · published port" : ""}
							</span>
							<Badge variant="outline">
								{rule.origin.startsWith("auto:") ? "automatic" : "yours"}
							</Badge>
						</li>
					))}
				</ul>
				{data && (
					<pre className="max-h-48 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap">
						{data.ufw.join("\n")}
					</pre>
				)}
			</DialogContent>
		</Dialog>
	);
};

const AddRule = ({ servers }: { servers: ServerRow[] }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [serverId, setServerId] = useState(servers[0]?.serverId ?? "");
	const [chain, setChain] = useState<"input" | "docker">("input");
	const [action, setAction] = useState<"allow" | "deny" | "limit">("allow");
	const [protocol, setProtocol] = useState<"tcp" | "udp">("tcp");
	const [port, setPort] = useState("");
	const [sourceKind, setSourceKind] = useState<"any" | "cidr" | "mesh">("any");
	const [cidr, setCidr] = useState("");
	const [comment, setComment] = useState("");
	const save = api.firewall.saveRule.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<Plus className="size-4" />
					Add rule
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add a rule</DialogTitle>
					<DialogDescription>
						Your rules sit alongside the automatic ones and win where they
						overlap.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label>Server</Label>
						<Select value={serverId} onValueChange={setServerId}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{servers.map((server) => (
									<SelectItem key={server.serverId} value={server.serverId}>
										{server.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Applies to</Label>
						<Select
							value={chain}
							onValueChange={(value) => setChain(value as "input" | "docker")}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="input">The server itself</SelectItem>
								<SelectItem value="docker">
									A published container port
								</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Action</Label>
						<Select
							value={action}
							onValueChange={(value) =>
								setAction(value as "allow" | "deny" | "limit")
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="allow">Allow</SelectItem>
								<SelectItem value="deny">Deny</SelectItem>
								<SelectItem value="limit">Allow, rate limited</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Protocol</Label>
						<Select
							value={protocol}
							onValueChange={(value) => setProtocol(value as "tcp" | "udp")}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="tcp">TCP</SelectItem>
								<SelectItem value="udp">UDP</SelectItem>
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Port or range</Label>
						<Input
							value={port}
							placeholder="5432 or 8000:8010"
							onChange={(event) => setPort(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>From</Label>
						<Select
							value={sourceKind}
							onValueChange={(value) =>
								setSourceKind(value as "any" | "cidr" | "mesh")
							}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="any">Anywhere</SelectItem>
								<SelectItem value="mesh">The secure network</SelectItem>
								<SelectItem value="cidr">A specific range</SelectItem>
							</SelectContent>
						</Select>
					</div>
					{sourceKind === "cidr" && (
						<div className="flex flex-col gap-1.5">
							<Label>Range</Label>
							<Input
								value={cidr}
								placeholder="203.0.113.0/24"
								onChange={(event) => setCidr(event.target.value)}
							/>
						</div>
					)}
					<div className="flex flex-col gap-1.5">
						<Label>Note</Label>
						<Input
							value={comment}
							placeholder="Office access to Postgres"
							onChange={(event) => setComment(event.target.value)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						isLoading={save.isPending}
						onClick={async () => {
							await save
								.mutateAsync({
									serverId,
									policyId: null,
									chain,
									action,
									protocol,
									port,
									source:
										sourceKind === "cidr"
											? { kind: "cidr", value: cidr }
											: { kind: sourceKind },
									comment,
									priority: 100,
									enabled: true,
								})
								.then(async () => {
									toast.success("Rule saved — apply to put it in place");
									await utils.firewall.invalidate();
									setOpen(false);
									setPort("");
									setComment("");
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

export const FirewallSettings = () => {
	const utils = api.useUtils();
	const { data } = api.firewall.list.useQuery();
	const setMode = api.firewall.setMode.useMutation();
	const apply = api.firewall.apply.useMutation();
	const drift = api.firewall.drift.useMutation();
	const removeRule = api.firewall.removeRule.useMutation();

	return (
		<section className="flex flex-col gap-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="flex items-center gap-2 text-lg font-medium">
						<ShieldCheck className="size-5 text-muted-foreground" />
						Firewall
					</h2>
					<p className="max-w-2xl text-sm text-muted-foreground">
						Rules are worked out from what each server runs, and you can
						override any of them. Published container ports are filtered too,
						which plain ufw cannot do. Every apply arms a rollback that fires
						unless Dokploy can still reach the server.
					</p>
				</div>
				{data && data.servers.length > 0 && <AddRule servers={data.servers} />}
			</div>

			<ul className="divide-y rounded-md border">
				{data?.servers.length === 0 && (
					<li className="p-6 text-center text-sm text-muted-foreground">
						No servers yet.
					</li>
				)}
				{data?.servers.map((server) => {
					const mode = (server.firewall?.mode ?? "off") as Mode;
					return (
						<li
							key={server.serverId}
							className="flex flex-wrap items-center gap-3 px-4 py-3"
						>
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="font-medium">{server.name}</span>
									<Badge
										variant={
											mode === "enforce"
												? "green"
												: mode === "audit"
													? "yellow"
													: "outline"
										}
									>
										{mode}
									</Badge>
									{server.firewall?.driftedAt && (
										<Badge variant="orange">drifted</Badge>
									)}
								</div>
								<p className="truncate text-xs text-muted-foreground">
									{MODE_HELP[mode]}
									{server.firewall?.appliedAt
										? ` · applied ${new Date(server.firewall.appliedAt).toLocaleString()}`
										: ""}
									{server.firewall?.lastError
										? ` · ${server.firewall.lastError}`
										: ""}
								</p>
							</div>
							<Select
								value={mode}
								onValueChange={async (value) => {
									await setMode
										.mutateAsync({
											serverId: server.serverId,
											mode: value as Mode,
										})
										.then(async () => {
											await utils.firewall.list.invalidate();
										})
										.catch(fail);
								}}
							>
								<SelectTrigger className="w-32">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="off">Off</SelectItem>
									<SelectItem value="audit">Audit</SelectItem>
									<SelectItem value="enforce">Enforce</SelectItem>
								</SelectContent>
							</Select>
							<Plan server={server} />
							<Button
								variant="ghost"
								size="sm"
								onClick={async () => {
									await drift
										.mutateAsync({ serverId: server.serverId })
										.then(async (result) => {
											toast.success(
												result.drift
													? "This server no longer matches what Dokploy applied"
													: "Matches what Dokploy applied",
											);
											await utils.firewall.list.invalidate();
										})
										.catch(fail);
								}}
							>
								Check
							</Button>
							<Button
								size="sm"
								disabled={mode !== "enforce"}
								onClick={async () => {
									await apply
										.mutateAsync({ serverIds: [server.serverId] })
										.then((result) =>
											toast.success(
												result.approvalId
													? "Waiting for approval"
													: "Applying — follow it in Activity",
											),
										)
										.catch(fail);
								}}
							>
								Apply
							</Button>
						</li>
					);
				})}
			</ul>

			{data && data.rules.length > 0 && (
				<div className="flex flex-col gap-2">
					<h3 className="text-sm font-medium">Your rules</h3>
					<ul className="divide-y rounded-md border text-sm">
						{data.rules.map((rule) => (
							<li key={rule.id} className="flex items-center gap-2 px-3 py-2">
								<Badge variant="outline" className="uppercase">
									{rule.action}
								</Badge>
								<code className="text-xs">
									{rule.protocol}/{rule.port}
								</code>
								<span className="text-xs text-muted-foreground">
									from{" "}
									{rule.source.kind === "cidr"
										? rule.source.value
										: rule.source.kind}
									{rule.chain === "docker" ? " · published port" : ""}
								</span>
								<span className="truncate text-xs text-muted-foreground">
									{rule.comment}
								</span>
								<DialogAction
									title="Delete this rule?"
									description="Apply afterwards to remove it from the server."
									type="destructive"
									onClick={async () => {
										await removeRule
											.mutateAsync({ id: rule.id })
											.then(async () => {
												toast.success("Deleted");
												await utils.firewall.invalidate();
											})
											.catch(fail);
									}}
								>
									<Button
										variant="ghost"
										size="icon"
										className="ml-auto text-destructive hover:text-destructive"
										aria-label="Delete rule"
									>
										<Trash2 className="size-4" />
									</Button>
								</DialogAction>
							</li>
						))}
					</ul>
				</div>
			)}
		</section>
	);
};
