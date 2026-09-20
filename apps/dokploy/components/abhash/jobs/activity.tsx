import { formatDistanceToNow } from "date-fns";
import {
	Activity,
	ArrowLeft,
	Ban,
	Loader2,
	RotateCcw,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetHeader,
	SheetTitle,
} from "@/components/ui/sheet";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { api, type RouterOutputs } from "@/utils/api";

type Job = RouterOutputs["abhashJobs"]["list"]["jobs"][number];
type Status = Job["status"];

const STATUS_VARIANT: Record<
	Status,
	"green" | "red" | "yellow" | "orange" | "outline" | "secondary"
> = {
	queued: "secondary",
	running: "yellow",
	succeeded: "green",
	failed: "red",
	cancelled: "outline",
	interrupted: "orange",
};

// The log keeps full ISO timestamps; the viewer only needs the time of day.
const compactTimes = (text: string) =>
	text.replace(/^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})\.\d+Z /gm, "$1  ");

const isActive = (status: Status) =>
	status === "queued" || status === "running";

export const StatusBadge = ({ status }: { status: Status }) => (
	<Badge variant={STATUS_VARIANT[status]} className="capitalize">
		{status === "running" && <Loader2 className="mr-1 animate-spin" />}
		{status}
	</Badge>
);

const JobLog = ({ job, onBack }: { job: Job; onBack: () => void }) => {
	const utils = api.useUtils();
	const [text, setText] = useState("");
	const offset = useRef(0);
	const bottom = useRef<HTMLDivElement>(null);
	const { data: detail } = api.abhashJobs.get.useQuery(
		{ id: job.id },
		{
			refetchInterval: (q) =>
				q.state.data && isActive(q.state.data.status) ? 2_000 : false,
		},
	);
	const status = detail?.status ?? job.status;
	const { data: chunk, refetch } = api.abhashJobs.log.useQuery(
		{ id: job.id, offset: offset.current },
		{ refetchInterval: isActive(status) ? 1_500 : false },
	);

	// One last read once the job ends, for lines written after the last poll.
	useEffect(() => {
		if (!isActive(status)) void refetch();
	}, [status, refetch]);

	useEffect(() => {
		if (!chunk || chunk.nextOffset <= offset.current) return;
		offset.current = chunk.nextOffset;
		setText((prev) => prev + chunk.text);
	}, [chunk]);

	useEffect(() => {
		bottom.current?.scrollIntoView({ block: "end" });
	}, [text]);

	const cancel = api.abhashJobs.cancel.useMutation({
		onSuccess: () => {
			toast.success("Cancellation requested");
			void utils.abhashJobs.invalidate();
		},
		onError: (e) => toast.error(e.message),
	});
	const retry = api.abhashJobs.retry.useMutation({
		onSuccess: () => {
			toast.success("Job queued again");
			void utils.abhashJobs.list.invalidate();
			onBack();
		},
		onError: (e) => toast.error(e.message),
	});

	return (
		<div className="flex min-h-0 flex-1 flex-col gap-3">
			<div className="flex items-center gap-2">
				<Button variant="ghost" size="sm" onClick={onBack}>
					<ArrowLeft className="size-4" /> All jobs
				</Button>
				<div className="ml-auto flex gap-2">
					{isActive(status) && (
						<Button
							variant="outline"
							size="sm"
							isLoading={cancel.isPending}
							onClick={() => cancel.mutate({ id: job.id })}
						>
							<Ban className="size-4" /> Cancel
						</Button>
					)}
					{!isActive(status) && (
						<Button
							variant="outline"
							size="sm"
							isLoading={retry.isPending}
							onClick={() => retry.mutate({ id: job.id })}
						>
							<RotateCcw className="size-4" /> Run again
						</Button>
					)}
				</div>
			</div>
			<div className="space-y-1">
				<div className="flex items-center gap-2">
					<StatusBadge status={status} />
					<span className="font-medium">{job.title}</span>
				</div>
				<p className="text-xs text-muted-foreground">
					{job.type} · started by {job.actor.name ?? job.actor.type}
					{detail?.error ? ` · ${detail.error}` : ""}
				</p>
				{status === "running" && detail?.progress != null && (
					<Progress value={detail.progress} className="h-1" />
				)}
			</div>
			<pre className="min-h-0 flex-1 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre-wrap break-all">
				{compactTimes(text) ||
					(isActive(status) ? "Waiting for output…" : "No output")}
				<div ref={bottom} />
			</pre>
		</div>
	);
};

const EnginePanel = ({ isOwner }: { isOwner: boolean }) => {
	const utils = api.useUtils();
	const { data: status } = api.abhashJobs.status.useQuery();
	const setEnabled = api.abhashJobs.setEnabled.useMutation({
		onSuccess: () => {
			toast.success("Job engine updated");
			void utils.abhashJobs.invalidate();
		},
		onError: (e) => toast.error(e.message),
	});
	if (!status || status.enabled) return null;
	return (
		<div className="space-y-3 rounded-md border p-4 text-sm">
			<p className="font-medium">Background jobs are off</p>
			<p className="text-muted-foreground">
				The job engine runs fleet commands, backups, restore drills and other
				long tasks in the background, using Dokploy's own Redis. Deploys do not
				depend on it.
			</p>
			{isOwner ? (
				<Button
					size="sm"
					isLoading={setEnabled.isPending}
					onClick={() => setEnabled.mutate({ enabled: true })}
				>
					Turn on
				</Button>
			) : (
				<p className="text-muted-foreground">
					Ask the organization owner to turn it on.
				</p>
			)}
		</div>
	);
};

export const ActivityButton = () => {
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<Job | null>(null);
	const utils = api.useUtils();
	const { data: me } = api.user.get.useQuery();
	const isAdmin = me?.role === "owner" || me?.role === "admin";
	const { data: engine } = api.abhashJobs.status.useQuery(undefined, {
		refetchInterval: open ? 10_000 : false,
	});
	const enabled = !!engine?.enabled;
	const { data } = api.abhashJobs.list.useQuery(
		{ limit: 50 },
		{
			enabled,
			refetchInterval: open ? 3_000 : 30_000,
		},
	);
	const selfTest = api.abhashJobs.selfTest.useMutation({
		onSuccess: (job) => {
			void utils.abhashJobs.list.invalidate();
			setSelected(job);
		},
		onError: (e) => toast.error(e.message),
	});

	if (!engine || (!enabled && me?.role !== "owner")) return null;
	const active = data?.active ?? 0;

	return (
		<>
			<SidebarMenuButton tooltip="Activity" onClick={() => setOpen(true)}>
				<Activity />
				<span>Activity</span>
				{active > 0 && (
					<Badge variant="yellow" className="ml-auto">
						{active}
					</Badge>
				)}
			</SidebarMenuButton>
			<Sheet
				open={open}
				onOpenChange={(next) => {
					setOpen(next);
					if (!next) setSelected(null);
				}}
			>
				<SheetContent className="flex w-full flex-col gap-0 sm:max-w-xl">
					{/* The sheet's own close button sits at top-3 right-3. */}
					<SheetHeader className="flex-row items-center justify-between gap-4 px-4 pt-4 pr-12 pb-3">
						<div className="flex flex-col gap-0.5">
							<SheetTitle>Activity</SheetTitle>
							<SheetDescription>Background jobs.</SheetDescription>
						</div>
						{enabled && !selected && isAdmin && (
							<Button
								variant="outline"
								size="sm"
								isLoading={selfTest.isPending}
								onClick={() => selfTest.mutate()}
							>
								Run self-test
							</Button>
						)}
					</SheetHeader>
					<div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
						<EnginePanel isOwner={me?.role === "owner"} />
						{enabled && engine.redisReachable === false && (
							<div className="flex items-center gap-2 rounded-md border border-destructive/40 p-3 text-sm text-destructive">
								<TriangleAlert className="size-4 shrink-0" />
								Redis is unreachable; jobs are paused.
							</div>
						)}
						{enabled && selected && (
							<JobLog job={selected} onBack={() => setSelected(null)} />
						)}
						{enabled && !selected && (
							<>
								<div className="min-h-0 flex-1 divide-y overflow-auto rounded-md border">
									{data?.jobs.length === 0 && (
										<p className="p-6 text-center text-sm text-muted-foreground">
											No jobs yet.
										</p>
									)}
									{data?.jobs.map((job) => (
										<button
											type="button"
											key={job.id}
											onClick={() => setSelected(job)}
											className="flex w-full items-center gap-3 p-3 text-left text-sm hover:bg-muted/50"
										>
											<StatusBadge status={job.status} />
											<div className="min-w-0 flex-1">
												<p className="truncate font-medium">{job.title}</p>
												<p className="truncate text-xs text-muted-foreground">
													{job.actor.name ?? job.actor.type} ·{" "}
													{formatDistanceToNow(new Date(job.createdAt), {
														addSuffix: true,
													})}
												</p>
											</div>
										</button>
									))}
								</div>
							</>
						)}
					</div>
				</SheetContent>
			</Sheet>
		</>
	);
};
