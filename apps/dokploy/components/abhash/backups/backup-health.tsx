import { formatDistanceToNow } from "date-fns";
import {
	DatabaseBackup,
	History,
	Play,
	Plus,
	ShieldCheck,
	Trash2,
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
import { Switch } from "@/components/ui/switch";
import { api, type RouterOutputs } from "@/utils/api";

type Overview = RouterOutputs["abhashBackups"]["overview"];
type Policy = Overview["policies"][number];
type Repository = Overview["repositories"][number];

const fail = (error: Error) => toast.error(error.message);

const megabytes = (bytes: number | null | undefined) =>
	bytes ? `${(bytes / 1_048_576).toFixed(1)} MB` : "—";

/**
 * An S3 destination and a restic repository are different objects: the
 * destination is a bucket credential the legacy jobs use, the repository is an
 * encrypted store restic owns a prefix of. They can share a bucket, which is
 * the usual reason someone is confused about being asked for both.
 */
export const repositoryFromDestination = (destination: {
	endpoint: string;
	bucket: string;
}) => {
	const host = destination.endpoint
		.replace(/^https?:\/\//, "")
		.replace(/\/+$/, "");
	return `s3:${host}/${destination.bucket}/restic`;
};

const AddRepository = () => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [repository, setRepository] = useState("");
	const [passwordRef, setPasswordRef] = useState("${{secret.RESTIC_PASSWORD}}");
	const [envText, setEnvText] = useState("");
	const save = api.abhashBackups.saveRepository.useMutation();
	const { data: destinations } = api.destination.all.useQuery();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline">
					<Plus className="size-4" />
					Add repository
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Add a backup repository</DialogTitle>
					<DialogDescription>
						Encrypted and deduplicated, on S3, B2, SFTP, WebDAV or local disk.
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					{destinations && destinations.length > 0 && (
						<div className="flex flex-col gap-1.5">
							<Label>Start from an S3 destination</Label>
							<Select
								onValueChange={(id) => {
									const picked = destinations.find(
										(row) => row.destinationId === id,
									);
									if (!picked) return;
									setName((current) => current || `${picked.name} (restic)`);
									setRepository(repositoryFromDestination(picked));
									setEnvText(
										"AWS_ACCESS_KEY_ID=${{secret.S3_KEY}}, AWS_SECRET_ACCESS_KEY=${{secret.S3_SECRET}}",
									);
								}}
							>
								<SelectTrigger>
									<SelectValue placeholder="Reuse a bucket you already added" />
								</SelectTrigger>
								<SelectContent>
									{destinations.map((row) => (
										<SelectItem
											key={row.destinationId}
											value={row.destinationId}
										>
											{row.name} · {row.bucket}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
							<p className="text-xs text-muted-foreground">
								Fills in the repository path. Restic needs its own prefix and
								its own password, so put the bucket keys in the vault and
								reference them below.
							</p>
						</div>
					)}
					<div className="flex flex-col gap-1.5">
						<Label>Name</Label>
						<Input
							value={name}
							placeholder="Offsite S3"
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Repository</Label>
						<Input
							value={repository}
							placeholder="s3:s3.eu-central-1.amazonaws.com/my-bucket/dokploy"
							onChange={(event) => setRepository(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Repository password (a vault secret)</Label>
						<Input
							value={passwordRef}
							onChange={(event) => setPasswordRef(event.target.value)}
						/>
						<p className="text-xs text-muted-foreground">
							Without it the backups cannot be read. Keep a copy elsewhere.
						</p>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Credentials (KEY=value per line, may be secret refs)</Label>
						<Input
							value={envText}
							placeholder="AWS_ACCESS_KEY_ID=${{secret.S3_KEY}}"
							onChange={(event) => setEnvText(event.target.value)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						isLoading={save.isPending}
						onClick={async () => {
							const env = Object.fromEntries(
								envText
									.split(/[\n,]+/)
									.map((line) => line.trim())
									.filter(Boolean)
									.map((line) => {
										const index = line.indexOf("=");
										return [line.slice(0, index), line.slice(index + 1)];
									}),
							);
							await save
								.mutateAsync({ name, repository, passwordRef, env })
								.then(async () => {
									toast.success("Saved");
									await utils.abhashBackups.overview.invalidate();
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

const AddPolicy = ({ repositories }: { repositories: Repository[] }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [targetKind, setTargetKind] = useState("postgres");
	const [target, setTarget] = useState("");
	const [repositoryId, setRepositoryId] = useState(repositories[0]?.id ?? "");
	const [cron, setCron] = useState("0 2 * * *");
	const [rpoHours, setRpoHours] = useState("26");
	const save = api.abhashBackups.savePolicy.useMutation();
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button>
					<Plus className="size-4" />
					New backup
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>New backup</DialogTitle>
					<DialogDescription>
						Kept daily, weekly, monthly and yearly, and pruned automatically.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-3 sm:grid-cols-2">
					<div className="flex flex-col gap-1.5">
						<Label>Name</Label>
						<Input
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>What</Label>
						<Select value={targetKind} onValueChange={setTargetKind}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{[
									"postgres",
									"mysql",
									"mariadb",
									"mongo",
									"redis",
									"volume",
									"path",
									"dokploy",
								].map((kind) => (
									<SelectItem key={kind} value={kind}>
										{kind}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>
							{["volume", "path", "dokploy"].includes(targetKind)
								? "Volume name or path"
								: "Service id"}
						</Label>
						<Input
							value={target}
							onChange={(event) => setTarget(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Repository</Label>
						<Select value={repositoryId} onValueChange={setRepositoryId}>
							<SelectTrigger>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{repositories.map((repository) => (
									<SelectItem key={repository.id} value={repository.id}>
										{repository.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Schedule (cron)</Label>
						<Input
							value={cron}
							onChange={(event) => setCron(event.target.value)}
						/>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label>Warn if older than (hours)</Label>
						<Input
							value={rpoHours}
							inputMode="numeric"
							onChange={(event) => setRpoHours(event.target.value)}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						isLoading={save.isPending}
						onClick={async () => {
							await save
								.mutateAsync({
									name,
									serverId: null,
									targetKind: targetKind as "postgres",
									target,
									repositoryId,
									copyToRepositoryIds: [],
									cronExpression: cron || null,
									timezone: "UTC",
									retention: {
										last: 3,
										daily: 7,
										weekly: 4,
										monthly: 6,
										yearly: 1,
									},
									rpoHours: Number(rpoHours) || 26,
									stopService: false,
									preHook: null,
									postHook: null,
									enabled: true,
								})
								.then(async () => {
									toast.success("Saved");
									await utils.abhashBackups.overview.invalidate();
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

const DrillCell = ({ policy }: { policy: Policy }) => {
	const utils = api.useUtils();
	const save = api.abhashBackups.saveDrill.useMutation();
	const run = api.abhashBackups.runDrill.useMutation();
	if (!policy.drill) {
		return (
			<Button
				variant="outline"
				size="sm"
				isLoading={save.isPending}
				onClick={async () => {
					await save
						.mutateAsync({
							policyId: policy.id,
							where: "isolated-local",
							drillServerId: null,
							cronExpression: "0 5 * * 0",
							timezone: "UTC",
							rtoMinutes: 30,
							queries: [],
							// Reading the live database is the point of a drill: a
							// snapshot that only agrees with its own recorded numbers
							// proves nothing.
							compareLive: true,
							enabled: true,
						})
						.then(async () => {
							toast.success("Weekly drill added");
							await utils.abhashBackups.overview.invalidate();
						})
						.catch(fail);
				}}
			>
				<ShieldCheck className="size-4" />
				Add drill
			</Button>
		);
	}
	const last = policy.lastDrill;
	return (
		<div className="flex items-center gap-2">
			{last ? (
				<Badge variant={last.status === "passed" ? "green" : "red"}>
					{last.status}
					{last.rtoSeconds ? ` · ${last.rtoSeconds}s` : ""}
				</Badge>
			) : (
				<Badge variant="outline">never run</Badge>
			)}
			<Button
				variant="ghost"
				size="sm"
				isLoading={run.isPending}
				onClick={async () => {
					await run
						.mutateAsync({ drillPolicyId: policy.drill?.id as string })
						.then((result) =>
							toast.success(
								result.approvalId
									? "Waiting for approval"
									: "Drill started — follow it in Activity",
							),
						)
						.catch(fail);
				}}
			>
				Run drill
			</Button>
		</div>
	);
};

const queued = (result: { approvalId: string | null }, started: string) =>
	toast.success(result.approvalId ? "Waiting for approval" : started);

/** Point-in-time recovery: only Postgres keeps a log it can be replayed from. */
const WalCell = ({ policy }: { policy: Policy }) => {
	const utils = api.useUtils();
	const [open, setOpen] = useState(false);
	const [when, setWhen] = useState("");
	const [replace, setReplace] = useState(false);
	const setWal = api.abhashBackups.setWal.useMutation();
	const recover = api.abhashBackups.recover.useMutation();
	const { data: window } = api.abhashBackups.recoveryWindow.useQuery(
		{ policyId: policy.id },
		{ enabled: open },
	);
	if (policy.targetKind !== "postgres") return null;

	const toggle = async (enabled: boolean) => {
		await setWal
			.mutateAsync({ policyId: policy.id, enabled })
			.then(async (result) => {
				queued(
					result,
					enabled ? "Turning on — follow it in Activity" : "Archiving is off",
				);
				await utils.abhashBackups.overview.invalidate();
				setOpen(false);
			})
			.catch(fail);
	};

	if (!policy.walEnabled) {
		return (
			<DialogAction
				title="Turn on point-in-time recovery?"
				description="The database is redeployed once. From then on its write-ahead log is archived, and backups become physical copies."
				onClick={() => toggle(true)}
			>
				<Button variant="ghost" size="sm">
					<History className="size-4" />
					Point-in-time
				</Button>
			</DialogAction>
		);
	}

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm">
					<History className="size-4" />
					Recover
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Recover {policy.name}</DialogTitle>
					<DialogDescription>
						{window?.earliest
							? `Any moment since ${new Date(window.earliest).toLocaleString()}.`
							: "Needs a base backup first."}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label>Moment (blank = latest)</Label>
						<Input
							type="datetime-local"
							step={1}
							value={when}
							onChange={(event) => setWhen(event.target.value)}
						/>
					</div>
					<div className="flex items-center justify-between rounded-md border p-3">
						<div>
							<p className="text-sm font-medium">Replace the live database</p>
							<p className="text-xs text-muted-foreground">
								Off recovers a copy. The old data is kept either way.
							</p>
						</div>
						<Switch checked={replace} onCheckedChange={setReplace} />
					</div>
				</div>
				<DialogFooter className="sm:justify-between">
					<Button
						variant="ghost"
						isLoading={setWal.isPending}
						onClick={() => toggle(false)}
					>
						Turn off archiving
					</Button>
					<Button
						variant={replace ? "destructive" : "default"}
						isLoading={recover.isPending}
						disabled={!window?.earliest}
						onClick={async () => {
							await recover
								.mutateAsync({
									policyId: policy.id,
									targetTime: when ? new Date(when).toISOString() : null,
									replaceService: replace,
								})
								.then((result) => {
									queued(result, "Recovering — follow it in Activity");
									setOpen(false);
								})
								.catch(fail);
						}}
					>
						Recover
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};

const walLine = (policy: Policy) => {
	if (!policy.walEnabled) return "";
	const status = policy.walStatus;
	if (!status) return " · WAL starting";
	if (status.problem) return ` · WAL: ${status.problem}`;
	return status.lastShippedAt
		? ` · WAL shipped ${formatDistanceToNow(new Date(status.lastShippedAt), { addSuffix: true })}`
		: " · WAL not shipped yet";
};

export const BackupHealth = ({ embedded = false }: { embedded?: boolean }) => {
	const utils = api.useUtils();
	const { data } = api.abhashBackups.overview.useQuery(undefined, {
		refetchInterval: 30_000,
	});
	const runNow = api.abhashBackups.runNow.useMutation();
	const check = api.abhashBackups.checkRepository.useMutation();
	const remove = api.abhashBackups.removePolicy.useMutation();

	return (
		<section className="flex flex-col gap-4">
			<PageHeader
				icon={embedded ? undefined : <DatabaseBackup className="size-5" />}
				// Inside the Backups tabs the tab label is the heading already.
				title={embedded ? "" : "Backups and drills"}
				description="Encrypted snapshots, and drills that prove a restore works."
				actions={
					<div className="flex gap-2">
						<AddRepository />
						{data && data.repositories.length > 0 && (
							<AddPolicy repositories={data.repositories} />
						)}
					</div>
				}
			/>

			{data && data.repositories.length > 0 && (
				<ul className="flex flex-wrap gap-2">
					{data.repositories.map((repository) => (
						<li
							key={repository.id}
							className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
						>
							<span className="font-medium">{repository.name}</span>
							<code className="text-muted-foreground">
								{repository.repository}
							</code>
							{repository.lastCheckAt && (
								<Badge variant={repository.lastCheckOk ? "green" : "red"}>
									{repository.lastCheckOk ? "verified" : "check failed"}
								</Badge>
							)}
							<Button
								variant="ghost"
								size="sm"
								className="h-6"
								onClick={async () => {
									await check
										.mutateAsync({
											repositoryId: repository.id,
											serverId: null,
										})
										.then(() => toast.success("Checking — see Activity"))
										.catch(fail);
								}}
							>
								Verify
							</Button>
						</li>
					))}
				</ul>
			)}

			<ul className="divide-y rounded-md border">
				{data?.policies.length === 0 && (
					<li className="p-6 text-center text-sm text-muted-foreground">
						No backups yet.
					</li>
				)}
				{data?.policies.map((policy) => (
					<li
						key={policy.id}
						className="flex flex-wrap items-center gap-3 px-4 py-3"
					>
						<div className="min-w-0 flex-1">
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-medium">{policy.name}</span>
								<Badge variant="outline">{policy.targetKind}</Badge>
								{policy.stale ? (
									<Badge variant="red">
										{policy.lastSuccess ? "out of date" : "never run"}
									</Badge>
								) : (
									<Badge variant="green">up to date</Badge>
								)}
								{policy.walEnabled && (
									<Badge variant={policy.walStatus?.problem ? "red" : "green"}>
										WAL
									</Badge>
								)}
								{policy.cronExpression && (
									<code className="text-xs text-muted-foreground">
										{policy.cronExpression}
									</code>
								)}
							</div>
							<p className="truncate text-xs text-muted-foreground">
								{policy.lastSuccess
									? `last ${formatDistanceToNow(new Date(policy.lastSuccess.startedAt), { addSuffix: true })} · ${megabytes(policy.lastSuccess.bytesAdded)} added`
									: "no successful backup yet"}
								{policy.lastRun?.status === "failed"
									? ` · last attempt failed: ${policy.lastRun.error?.slice(0, 120)}`
									: ""}
								{walLine(policy)}
							</p>
						</div>
						<WalCell policy={policy} />
						<DrillCell policy={policy} />
						<Button
							size="sm"
							isLoading={runNow.isPending}
							onClick={async () => {
								await runNow
									.mutateAsync({ policyId: policy.id })
									.then((result) =>
										toast.success(
											result.approvalId
												? "Waiting for approval"
												: "Backing up — follow it in Activity",
										),
									)
									.catch(fail);
							}}
						>
							<Play className="size-4" />
							Back up now
						</Button>
						<DialogAction
							title={`Delete ${policy.name}?`}
							description="The snapshots already taken are kept in the repository."
							type="destructive"
							onClick={async () => {
								await remove
									.mutateAsync({ id: policy.id })
									.then(async () => {
										toast.success("Deleted");
										await utils.abhashBackups.overview.invalidate();
									})
									.catch(fail);
							}}
						>
							<Button
								variant="ghost"
								size="icon"
								className="text-destructive hover:text-destructive"
								aria-label={`Delete ${policy.name}`}
							>
								<Trash2 className="size-4" />
							</Button>
						</DialogAction>
					</li>
				))}
			</ul>
		</section>
	);
};
