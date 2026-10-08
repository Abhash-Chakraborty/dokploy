import { formatDistanceToNow } from "date-fns";
import { ArrowUpRight, Loader2, Play } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { describeCron } from "@/lib/cron-text";
import { cn } from "@/lib/utils";
import { api, type RouterOutputs } from "@/utils/api";

type Job = RouterOutputs["abhashBackups"]["jobs"][number];

const KIND_LABEL: Record<Job["kind"], string> = {
	dump: "database dump",
	volume: "volume",
	dokploy: "panel",
	restic: "restic",
};

const RunStatus = ({ job }: { job: Job }) => {
	if (!job.lastRun) {
		return <span className="text-muted-foreground">Never ran</span>;
	}
	const { status, at, error } = job.lastRun;
	const when = formatDistanceToNow(new Date(at), { addSuffix: true });
	const tone =
		status === "error"
			? "bg-status-failed"
			: status === "running"
				? "bg-status-deploying animate-pulse"
				: "bg-status-running";
	const label = (
		<span
			className={cn(
				"inline-flex items-center gap-2",
				status === "error" && "text-status-failed",
			)}
		>
			<span className={cn("size-1.5 shrink-0 rounded-full", tone)} />
			{status === "error"
				? `Failed ${when}`
				: status === "running"
					? "Running now"
					: when}
		</span>
	);
	if (!error) return label;
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<span className="cursor-help">{label}</span>
			</TooltipTrigger>
			<TooltipContent className="max-w-sm font-mono">{error}</TooltipContent>
		</Tooltip>
	);
};

export const BackupJobs = () => {
	const utils = api.useUtils();
	const { data: jobs, isPending } = api.abhashBackups.jobs.useQuery(undefined, {
		refetchInterval: 15_000,
	});
	const postgres = api.backup.manualBackupPostgres.useMutation();
	const mysql = api.backup.manualBackupMySql.useMutation();
	const mariadb = api.backup.manualBackupMariadb.useMutation();
	const mongo = api.backup.manualBackupMongo.useMutation();
	const libsql = api.backup.manualBackupLibsql.useMutation();
	const compose = api.backup.manualBackupCompose.useMutation();
	const webServer = api.backup.manualBackupWebServer.useMutation();
	const volume = api.volumeBackups.runManually.useMutation();
	const restic = api.abhashBackups.runNow.useMutation();
	const [running, setRunning] = useState<string | null>(null);

	const runJob = async (job: Job) => {
		const { run } = job;
		setRunning(job.id);
		try {
			if (run.engine === "volume") {
				await volume.mutateAsync({ volumeBackupId: run.volumeBackupId });
			} else if (run.engine === "restic") {
				await restic.mutateAsync({ policyId: run.policyId });
			} else {
				const input = { backupId: run.backupId };
				if (run.databaseType === "web-server")
					await webServer.mutateAsync(input);
				else if (run.backupType === "compose") await compose.mutateAsync(input);
				else if (run.databaseType === "postgres")
					await postgres.mutateAsync(input);
				else if (run.databaseType === "mysql") await mysql.mutateAsync(input);
				else if (run.databaseType === "mariadb")
					await mariadb.mutateAsync(input);
				else if (run.databaseType === "mongo") await mongo.mutateAsync(input);
				else if (run.databaseType === "libsql") await libsql.mutateAsync(input);
			}
			toast.success(`${job.name}: backup started`);
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "The backup did not start",
			);
		} finally {
			setRunning(null);
			await utils.abhashBackups.jobs.invalidate();
		}
	};

	if (isPending) {
		return (
			<div className="flex items-center gap-2 py-10 text-[13px] text-muted-foreground">
				<Loader2 className="size-4 animate-spin" /> Loading backups…
			</div>
		);
	}
	if (!jobs?.length) {
		return (
			<div className="flex flex-col items-start gap-2 py-10">
				<span className="text-[15px] font-semibold">No backups yet</span>
				<span className="max-w-lg text-[13px] text-muted-foreground">
					A backup copies a database, a volume or Dokploy itself on a schedule
					and sends it to your storage. Start with “New backup”.
				</span>
			</div>
		);
	}

	const groups = new Map<string, Job[]>();
	for (const job of jobs) {
		const key = job.project ?? "Other";
		groups.set(key, [...(groups.get(key) ?? []), job]);
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[720px] text-[13px]">
				<thead>
					<tr className="text-left text-xs text-muted-foreground">
						<th className="h-9 pr-4 font-medium">What</th>
						<th className="h-9 pr-4 font-medium">When</th>
						<th className="h-9 pr-4 font-medium">Where</th>
						<th className="h-9 pr-4 font-medium">Last run</th>
						<th className="h-9 w-32" />
					</tr>
				</thead>
				{[...groups.entries()].map(([project, rows]) => (
					<tbody key={project}>
						<tr>
							<th
								colSpan={5}
								className="pt-5 pb-1.5 text-left text-xs font-medium text-muted-foreground"
							>
								{project}
							</th>
						</tr>
						{rows.map((job) => (
							<tr
								key={job.id}
								className={cn(
									"border-b border-border/60",
									!job.enabled && "text-muted-foreground",
								)}
							>
								<td className="py-2.5 pr-4">
									<span className="font-medium">{job.name}</span>
									<span className="ml-2 rounded bg-secondary px-1.5 py-0.5 text-[11px] text-muted-foreground">
										{KIND_LABEL[job.kind]}
									</span>
									{job.service && (
										<span className="ml-2 text-muted-foreground">
											{job.service}
										</span>
									)}
									{!job.enabled && (
										<span className="ml-2 text-xs">· paused</span>
									)}
								</td>
								<td className="py-2.5 pr-4">
									{describeCron(job.schedule) ?? (
										<span className="font-mono text-xs">{job.schedule}</span>
									)}
								</td>
								<td className="py-2.5 pr-4">{job.storage}</td>
								<td className="py-2.5 pr-4">
									<RunStatus job={job} />
								</td>
								<td className="py-2.5 text-right whitespace-nowrap">
									<Button
										variant="ghost"
										size="sm"
										isLoading={running === job.id}
										onClick={() => runJob(job)}
									>
										{running !== job.id && <Play className="size-3.5" />}
										Run now
									</Button>
									{job.href && (
										<Button variant="ghost" size="icon-sm" asChild>
											<Link href={job.href} aria-label={`Open ${job.name}`}>
												<ArrowUpRight className="size-4" />
											</Link>
										</Button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				))}
			</table>
		</div>
	);
};
