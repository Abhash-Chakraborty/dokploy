import {
	CalendarClock,
	CheckCircle2,
	CircleSlash,
	Loader2,
	PlayIcon,
	SearchIcon,
	Trash2,
	XCircle,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { HandleSchedules } from "@/components/dashboard/application/schedules/handle-schedules";
import { DateTooltip } from "@/components/shared/date-tooltip";
import { DialogAction } from "@/components/shared/dialog-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, type RouterOutputs } from "@/utils/api";

type ScheduleRow = RouterOutputs["schedule"]["allForOrganization"][number];

type TypeFilter =
	| "all"
	| "application"
	| "compose"
	| "server"
	| "dokploy-server";

const TYPE_LABELS: Record<string, string> = {
	application: "Application",
	compose: "Compose",
	server: "Server",
	"dokploy-server": "Host",
};

/** Where a schedule row points, as a single human-readable string. */
const describeTarget = (schedule: ScheduleRow) => {
	const { target } = schedule;
	if (schedule.scheduleType === "dokploy-server") return "Dokploy host";
	if (schedule.scheduleType === "server") {
		return target.serverName ?? "Unknown server";
	}
	const project = target.projectName ?? "Unknown project";
	const service = target.serviceName ?? "Unknown service";
	return `${project} / ${service}`;
};

/**
 * Link to the owning service page when we have every id the route needs.
 * Returns null when we do not, so the caller renders plain text rather than a
 * link that would 404.
 */
const buildServiceHref = (schedule: ScheduleRow) => {
	const { target } = schedule;
	if (!target.projectId || !target.environmentId || !target.serviceId) {
		return null;
	}
	const serviceKind =
		schedule.scheduleType === "compose" ? "compose" : "application";
	return `/dashboard/project/${target.projectId}/environment/${target.environmentId}/services/${serviceKind}/${target.serviceId}`;
};

const LastRunBadge = ({ schedule }: { schedule: ScheduleRow }) => {
	if (!schedule.lastRun) {
		return <span className="text-muted-foreground text-sm">Never</span>;
	}
	const { status, createdAt } = schedule.lastRun;
	const variant =
		status === "done"
			? "default"
			: status === "error"
				? "destructive"
				: "secondary";
	return (
		<div className="flex flex-col gap-1">
			<Badge variant={variant} className="w-fit capitalize">
				{status}
			</Badge>
			<DateTooltip date={createdAt} className="text-muted-foreground text-xs" />
		</div>
	);
};

export const ShowAllSchedules = () => {
	const utils = api.useUtils();
	const {
		data: schedules,
		isLoading,
		error,
	} = api.schedule.allForOrganization.useQuery();

	const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
	const [search, setSearch] = useState("");
	const [runningId, setRunningId] = useState<string | null>(null);

	const { mutateAsync: updateSchedule } = api.schedule.update.useMutation();
	const { mutateAsync: deleteSchedule } = api.schedule.delete.useMutation();
	const { mutateAsync: runManually } = api.schedule.runManually.useMutation();

	const rows = useMemo(() => {
		const all = schedules ?? [];
		const term = search.trim().toLowerCase();
		return all.filter((schedule) => {
			if (typeFilter !== "all" && schedule.scheduleType !== typeFilter) {
				return false;
			}
			if (!term) return true;
			return (
				schedule.name.toLowerCase().includes(term) ||
				describeTarget(schedule).toLowerCase().includes(term)
			);
		});
	}, [schedules, typeFilter, search]);

	const stats = useMemo(() => {
		const all = schedules ?? [];
		return {
			total: all.length,
			enabled: all.filter((schedule) => schedule.enabled).length,
			failing: all.filter((schedule) => schedule.lastRun?.status === "error")
				.length,
		};
	}, [schedules]);

	const refresh = async () => {
		await utils.schedule.allForOrganization.invalidate();
	};

	const toggleEnabled = async (schedule: ScheduleRow, enabled: boolean) => {
		try {
			await updateSchedule({
				scheduleId: schedule.scheduleId,
				name: schedule.name,
				cronExpression: schedule.cronExpression,
				command: schedule.command,
				scheduleType: schedule.scheduleType,
				shellType: schedule.shellType,
				enabled,
			});
			await refresh();
			toast.success(enabled ? "Schedule enabled" : "Schedule disabled");
		} catch (mutationError) {
			toast.error(
				mutationError instanceof Error
					? mutationError.message
					: "Failed to update the schedule",
			);
		}
	};

	const runNow = async (schedule: ScheduleRow) => {
		setRunningId(schedule.scheduleId);
		try {
			const result = await runManually({ scheduleId: schedule.scheduleId });
			await refresh();
			if (result.status === "error") {
				toast.error(`${schedule.name} finished with an error`);
			} else {
				toast.success(`${schedule.name} ran successfully`);
			}
		} catch (mutationError) {
			toast.error(
				mutationError instanceof Error
					? mutationError.message
					: "Failed to run the schedule",
			);
		} finally {
			setRunningId(null);
		}
	};

	const removeSchedule = async (schedule: ScheduleRow) => {
		try {
			await deleteSchedule({ scheduleId: schedule.scheduleId });
			await refresh();
			toast.success("Schedule deleted");
		} catch (mutationError) {
			toast.error(
				mutationError instanceof Error
					? mutationError.message
					: "Failed to delete the schedule",
			);
		}
	};

	if (error) {
		return (
			<Card className="bg-background">
				<CardContent className="flex flex-col items-center gap-2 py-10">
					<XCircle className="size-6 text-destructive" />
					<span className="text-sm text-muted-foreground">{error.message}</span>
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="flex w-full flex-col gap-6">
			<div className="grid gap-4 sm:grid-cols-3">
				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between pb-2">
						<CardTitle className="text-sm font-medium">Schedules</CardTitle>
						<CalendarClock className="size-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<span className="text-2xl font-bold">{stats.total}</span>
					</CardContent>
				</Card>
				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between pb-2">
						<CardTitle className="text-sm font-medium">Enabled</CardTitle>
						<CheckCircle2 className="size-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<span className="text-2xl font-bold">{stats.enabled}</span>
					</CardContent>
				</Card>
				<Card className="bg-background">
					<CardHeader className="flex flex-row items-center justify-between pb-2">
						<CardTitle className="text-sm font-medium">
							Failing last run
						</CardTitle>
						<CircleSlash className="size-4 text-muted-foreground" />
					</CardHeader>
					<CardContent>
						<span
							className={
								stats.failing > 0
									? "text-2xl font-bold text-destructive"
									: "text-2xl font-bold"
							}
						>
							{stats.failing}
						</span>
					</CardContent>
				</Card>
			</div>

			<Card className="bg-background">
				<CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<div className="flex flex-col gap-1">
						<CardTitle>All schedules</CardTitle>
						<span className="text-sm text-muted-foreground">
							Every cron job in this organization, across projects, servers and
							the Dokploy host.
						</span>
					</div>
					<div className="flex flex-col gap-2 sm:flex-row">
						<div className="relative">
							<SearchIcon className="absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
							<Input
								placeholder="Search name or target"
								className="pl-8 sm:w-64"
								value={search}
								onChange={(event) => setSearch(event.target.value)}
							/>
						</div>
						<Select
							value={typeFilter}
							onValueChange={(value) => setTypeFilter(value as TypeFilter)}
						>
							<SelectTrigger className="sm:w-44">
								<SelectValue placeholder="All types" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">All types</SelectItem>
								<SelectItem value="application">Application</SelectItem>
								<SelectItem value="compose">Compose</SelectItem>
								<SelectItem value="server">Server</SelectItem>
								<SelectItem value="dokploy-server">Host</SelectItem>
							</SelectContent>
						</Select>
					</div>
				</CardHeader>
				<CardContent>
					{isLoading ? (
						<div className="flex min-h-[10rem] items-center justify-center">
							<Loader2 className="size-6 animate-spin text-muted-foreground" />
						</div>
					) : rows.length === 0 ? (
						<div className="flex min-h-[10rem] flex-col items-center justify-center gap-2 text-center">
							<CalendarClock className="size-8 text-muted-foreground" />
							<span className="text-sm font-medium">
								{(schedules?.length ?? 0) === 0
									? "No schedules yet"
									: "No schedules match this filter"}
							</span>
							<span className="max-w-md text-sm text-muted-foreground">
								Application and compose schedules are created from each
								service's Schedules tab. Server and host schedules are created
								from the Host schedules tab.
							</span>
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Name</TableHead>
									<TableHead>Type</TableHead>
									<TableHead>Target</TableHead>
									<TableHead>Schedule</TableHead>
									<TableHead>Last run</TableHead>
									<TableHead className="text-center">Enabled</TableHead>
									<TableHead className="text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((schedule) => {
									const href = buildServiceHref(schedule);
									const targetLabel = describeTarget(schedule);
									return (
										<TableRow key={schedule.scheduleId}>
											<TableCell className="max-w-[16rem]">
												<div className="flex flex-col">
													<span className="truncate font-medium">
														{schedule.name}
													</span>
													{schedule.description ? (
														<span className="truncate text-xs text-muted-foreground">
															{schedule.description}
														</span>
													) : null}
												</div>
											</TableCell>
											<TableCell>
												<Badge variant="outline">
													{TYPE_LABELS[schedule.scheduleType] ??
														schedule.scheduleType}
												</Badge>
											</TableCell>
											<TableCell className="max-w-[16rem]">
												{href ? (
													<Link
														href={href}
														className="truncate text-sm underline-offset-4 hover:underline"
													>
														{targetLabel}
													</Link>
												) : (
													<span className="truncate text-sm">
														{targetLabel}
													</span>
												)}
											</TableCell>
											<TableCell>
												<div className="flex flex-col gap-1">
													<code className="w-fit rounded bg-muted px-2 py-0.5 text-xs">
														{schedule.cronExpression}
													</code>
													<span className="text-xs text-muted-foreground">
														{schedule.timezone ?? "UTC"}
													</span>
												</div>
											</TableCell>
											<TableCell>
												<LastRunBadge schedule={schedule} />
											</TableCell>
											<TableCell className="text-center">
												<Switch
													checked={schedule.enabled}
													onCheckedChange={(checked) =>
														toggleEnabled(schedule, checked)
													}
												/>
											</TableCell>
											<TableCell>
												<div className="flex items-center justify-end gap-2">
													<Button
														variant="ghost"
														size="icon"
														title="Run now"
														disabled={runningId === schedule.scheduleId}
														onClick={() => runNow(schedule)}
													>
														{runningId === schedule.scheduleId ? (
															<Loader2 className="size-4 animate-spin" />
														) : (
															<PlayIcon className="size-4" />
														)}
													</Button>
													<HandleSchedules
														scheduleId={schedule.scheduleId}
														scheduleType={schedule.scheduleType}
													/>
													<DialogAction
														title="Delete schedule"
														description="This removes the schedule permanently. The service itself is not affected."
														type="destructive"
														onClick={() => removeSchedule(schedule)}
													>
														<Button variant="ghost" size="icon" title="Delete">
															<Trash2 className="size-4 text-destructive" />
														</Button>
													</DialogAction>
												</div>
											</TableCell>
										</TableRow>
									);
								})}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
};
