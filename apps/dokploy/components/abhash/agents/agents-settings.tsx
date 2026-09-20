import { formatDistanceToNow } from "date-fns";
import { Bot, Check, Copy, Plus, Trash2, X } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { api, type RouterOutputs } from "@/utils/api";

type Agent = RouterOutputs["agents"]["list"][number];
type ApprovalMode = "destructive" | "all" | "none";

const fail = (error: Error) => toast.error(error.message);

const CreateAgent = () => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [role, setRole] = useState<"member" | "admin">("member");
	const create = api.agents.create.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<Plus className="size-4" />
					New agent
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New agent</DialogTitle>
					<DialogDescription>
						A service account with its own keys. Give it access like a person:
						teams and per-project roles.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label>Name</Label>
						<Input
							value={name}
							placeholder="Claude"
							onChange={(e) => setName(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>What it does</Label>
						<Input
							value={description}
							placeholder="Deploys and watches the staging projects"
							onChange={(e) => setDescription(e.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Base role</Label>
						<Select
							value={role}
							onValueChange={(value) => setRole(value as "member" | "admin")}
						>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="member">
									Member (access you grant it)
								</SelectItem>
								<SelectItem value="admin">Admin (everything)</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</div>
				<DialogFooter>
					<Button
						isLoading={create.isPending}
						onClick={async () => {
							await create
								.mutateAsync({ name, description, role })
								.then(async () => {
									toast.success(`${name} created`);
									await utils.agents.list.invalidate();
									setOpen(false);
									setName("");
									setDescription("");
								})
								.catch(fail);
						}}
					>
						Create
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const NewKey = ({ agent }: { agent: Agent }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("Default key");
	const [readOnly, setReadOnly] = useState(false);
	const [approvalMode, setApprovalMode] = useState<ApprovalMode>("destructive");
	const [allow, setAllow] = useState("");
	const [ips, setIps] = useState("");
	const [expiresInDays, setExpiresInDays] = useState("90");
	const [issued, setIssued] = useState<string | null>(null);
	const create = api.agents.createKey.useMutation();
	const split = (value: string) =>
		value
			.split(/[\s,]+/)
			.map((item) => item.trim())
			.filter(Boolean);
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (!next) setIssued(null);
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					New key
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New key for {agent.name}</DialogTitle>
					<DialogDescription>
						Shown once. Carries the agent's access, narrowed by these limits.
					</DialogDescription>
				</DialogHeader>
				{issued ? (
					<div className="flex items-start gap-2">
						<pre className="flex-1 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs break-all">
							{issued}
						</pre>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Copy"
							onClick={async () => {
								await navigator.clipboard.writeText(issued);
								toast.success("Copied");
							}}
						>
							<Copy className="size-4" />
						</Button>
					</div>
				) : (
					<div className="flex flex-col gap-3">
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label>Name</Label>
								<Input value={name} onChange={(e) => setName(e.target.value)} />
							</div>
							<div className="flex flex-col gap-1.5">
								<Label>Expires in (days, blank = never)</Label>
								<Input
									value={expiresInDays}
									inputMode="numeric"
									onChange={(e) => setExpiresInDays(e.target.value)}
								/>
							</div>
						</div>
						<div className="flex items-center justify-between rounded-md border p-3">
							<div>
								<p className="text-sm font-medium">Read-only</p>
								<p className="text-xs text-muted-foreground">Reads only.</p>
							</div>
							<Switch checked={readOnly} onCheckedChange={setReadOnly} />
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Human approval</Label>
							<Select
								value={approvalMode}
								onValueChange={(value) =>
									setApprovalMode(value as ApprovalMode)
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="destructive">
										For destructive actions (recommended)
									</SelectItem>
									<SelectItem value="all">For everything it runs</SelectItem>
									<SelectItem value="none">Never ask</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Only these calls (optional)</Label>
							<Input
								value={allow}
								placeholder="project.*, application.one, abhashJobs.*"
								onChange={(e) => setAllow(e.target.value)}
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label>Only from these addresses (optional)</Label>
							<Input
								value={ips}
								placeholder="100.97.0.0/16, 10.0.0.5"
								onChange={(e) => setIps(e.target.value)}
							/>
						</div>
					</div>
				)}
				{!issued && (
					<DialogFooter>
						<Button
							isLoading={create.isPending}
							onClick={async () => {
								await create
									.mutateAsync({
										agentId: agent.id,
										name,
										expiresInDays: expiresInDays ? Number(expiresInDays) : null,
										policy: {
											readOnly,
											approvalMode,
											allow: split(allow),
											ipAllowList: split(ips),
										},
									})
									.then(async (key) => {
										setIssued(key.key);
										await utils.agents.list.invalidate();
									})
									.catch(fail);
							}}
						>
							Create key
						</Button>
					</DialogFooter>
				)}
			</DialogContent>
		</Dialog>
	);
};

const Approvals = () => {
	const utils = api.useUtils();
	const { data: approvals } = api.agents.approvals.list.useQuery(
		{ status: "pending" },
		{ refetchInterval: 15_000 },
	);
	const decide = api.agents.approvals.decide.useMutation();
	if (!approvals?.length) return null;
	return (
		<div className="flex flex-col gap-2">
			<h3 className="text-sm font-medium">Waiting for you</h3>
			<ul className="divide-y rounded-md border">
				{approvals.map((approval) => (
					<li key={approval.id} className="flex items-center gap-3 px-4 py-3">
						<div className="min-w-0 flex-1">
							<p className="truncate text-sm font-medium">{approval.summary}</p>
							<p className="truncate text-xs text-muted-foreground">
								{approval.requester.name ?? approval.requester.type} ·{" "}
								{approval.operation} ·{" "}
								{formatDistanceToNow(new Date(approval.createdAt), {
									addSuffix: true,
								})}
							</p>
						</div>
						<Button
							variant="outline"
							size="sm"
							onClick={async () => {
								await decide
									.mutateAsync({ id: approval.id, approve: true })
									.then(async () => {
										toast.success("Approved — running now");
										await utils.agents.approvals.invalidate();
									})
									.catch(fail);
							}}
						>
							<Check className="size-4" /> Approve
						</Button>
						<Button
							variant="ghost"
							size="sm"
							onClick={async () => {
								await decide
									.mutateAsync({ id: approval.id, approve: false })
									.then(async () => {
										toast.success("Rejected");
										await utils.agents.approvals.invalidate();
									})
									.catch(fail);
							}}
						>
							<X className="size-4" /> Reject
						</Button>
					</li>
				))}
			</ul>
		</div>
	);
};

export const AgentsSettings = () => {
	const utils = api.useUtils();
	const { data: agents } = api.agents.list.useQuery();
	const update = api.agents.update.useMutation();
	const remove = api.agents.remove.useMutation();
	const revoke = api.agents.revokeKey.useMutation();

	return (
		<section className="flex flex-col gap-4">
			<PageHeader
				icon={<Bot className="size-5" />}
				title="Agents"
				description="Service accounts with scoped keys. They never see secret values."
				actions={<CreateAgent />}
			/>

			<Approvals />

			<ul className="divide-y rounded-md border">
				{agents?.length === 0 && (
					<li className="p-6 text-center text-sm text-muted-foreground">
						No agents yet.
					</li>
				)}
				{agents?.map((agent) => (
					<li key={agent.id} className="flex flex-col gap-2 px-4 py-3">
						<div className="flex flex-wrap items-center gap-2">
							<span className="font-medium">{agent.name}</span>
							{!agent.enabled && <Badge variant="orange">paused</Badge>}
							<span className="text-xs text-muted-foreground">
								{agent.description}
							</span>
							<div className="ml-auto flex items-center gap-2">
								<NewKey agent={agent} />
								<Button
									variant="ghost"
									size="sm"
									onClick={async () => {
										await update
											.mutateAsync({ id: agent.id, enabled: !agent.enabled })
											.then(async () => {
												await utils.agents.list.invalidate();
											})
											.catch(fail);
									}}
								>
									{agent.enabled ? "Pause" : "Resume"}
								</Button>
								<DialogAction
									title={`Delete ${agent.name}?`}
									description="Its keys stop working immediately."
									type="destructive"
									onClick={async () => {
										await remove
											.mutateAsync({ id: agent.id })
											.then(async () => {
												toast.success(`${agent.name} deleted`);
												await utils.agents.list.invalidate();
											})
											.catch(fail);
									}}
								>
									<Button
										variant="ghost"
										size="icon"
										className="text-destructive hover:text-destructive"
										aria-label={`Delete ${agent.name}`}
									>
										<Trash2 className="size-4" />
									</Button>
								</DialogAction>
							</div>
						</div>
						{agent.keys.length > 0 && (
							<ul className="flex flex-col gap-1 text-xs text-muted-foreground">
								{agent.keys.map((key) => (
									<li key={key.id} className="flex items-center gap-2">
										<code>{key.start}…</code>
										<span>{key.name}</span>
										<span>
											{key.lastRequest
												? `last used ${formatDistanceToNow(new Date(key.lastRequest), { addSuffix: true })}`
												: "never used"}
										</span>
										<Button
											variant="ghost"
											size="sm"
											className="ml-auto h-6 text-destructive hover:text-destructive"
											onClick={async () => {
												await revoke
													.mutateAsync({ agentId: agent.id, keyId: key.id })
													.then(async () => {
														toast.success("Key revoked");
														await utils.agents.list.invalidate();
													})
													.catch(fail);
											}}
										>
											Revoke
										</Button>
									</li>
								))}
							</ul>
						)}
					</li>
				))}
			</ul>
		</section>
	);
};
