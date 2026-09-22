import { Loader2, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { commonCronExpressions } from "@/components/dashboard/application/schedules/handle-schedules";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { InfoTooltip } from "@/components/shared/info-tooltip";
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
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api, type RouterOutputs } from "@/utils/api";

type Entry = RouterOutputs["fleet"]["cron"]["list"][number];

const SOURCE_LABEL: Record<Entry["source"], string> = {
	user: "User crontab",
	file: "System file",
	periodic: "cron.* directory",
	timer: "systemd timer",
};

const describe = (schedule: string) =>
	commonCronExpressions.find((preset) => preset.value === schedule)?.label;

export const HostCrontab = ({ serverId }: { serverId: string }) => {
	const [filter, setFilter] = useState("");
	const { data, isPending, isFetching, error, refetch } =
		api.fleet.cron.list.useQuery({ serverId }, { retry: false });
	const remove = api.fleet.cron.remove.useMutation();

	const rows = useMemo(() => {
		const needle = filter.trim().toLowerCase();
		const list = data ?? [];
		const shown = needle
			? list.filter((entry) =>
					[entry.command, entry.schedule, entry.origin, entry.name ?? ""]
						.join(" ")
						.toLowerCase()
						.includes(needle),
				)
			: list;
		// Dokploy's own jobs first, then the rest in the order the host lists them.
		return [...shown].sort((a, b) => Number(b.managed) - Number(a.managed));
	}, [data, filter]);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-center gap-2">
				<div className="relative min-w-48 flex-1 sm:max-w-sm">
					<Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
					<Input
						value={filter}
						onChange={(event) => setFilter(event.target.value)}
						placeholder="Filter cron jobs..."
						className="h-9 pl-8"
					/>
				</div>
				<span className="text-xs text-muted-foreground">
					{data ? `${rows.length} of ${data.length}` : ""}
				</span>
				<InfoTooltip
					content={
						<span>
							Everything cron runs on this server: user crontabs,{" "}
							<code>/etc/crontab</code>, <code>/etc/cron.d</code>, the{" "}
							<code>cron.daily</code>-style directories and systemd timers. Jobs
							you add here go to <code>/etc/cron.d/dokploy</code>; the rest is
							shown read-only and never rewritten.
						</span>
					}
				/>
				<div className="ml-auto flex items-center gap-2">
					<Button
						variant="outline"
						size="icon-sm"
						aria-label="Refresh"
						title="Refresh"
						onClick={() => refetch()}
						disabled={isFetching}
					>
						<RefreshCw className={isFetching ? "animate-spin" : ""} />
					</Button>
					<AddHostCron serverId={serverId} onAdded={() => refetch()} />
				</div>
			</div>

			{error ? (
				<AlertBlock type="error">{error.message}</AlertBlock>
			) : isPending ? (
				<div className="flex h-40 items-center justify-center text-muted-foreground">
					<Loader2 className="size-5 animate-spin" />
				</div>
			) : rows.length === 0 ? (
				<div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
					{data?.length ? "Nothing matches the filter" : "No cron jobs found"}
				</div>
			) : (
				<div className="overflow-hidden rounded-lg border">
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead className="w-44">Schedule</TableHead>
								<TableHead>Command</TableHead>
								<TableHead className="w-24">User</TableHead>
								<TableHead className="w-48">Source</TableHead>
								<TableHead className="w-12" />
							</TableRow>
						</TableHeader>
						<TableBody>
							{rows.map((entry) => (
								<TableRow key={entry.id}>
									<TableCell className="align-top">
										<div className="font-mono text-xs">{entry.schedule}</div>
										{describe(entry.schedule) && (
											<div className="text-xs text-muted-foreground">
												{describe(entry.schedule)}
											</div>
										)}
									</TableCell>
									<TableCell className="max-w-0 align-top">
										{entry.name && (
											<div className="truncate text-sm font-medium">
												{entry.name}
											</div>
										)}
										<div
											className="truncate font-mono text-xs text-muted-foreground"
											title={entry.command}
										>
											{entry.command}
										</div>
									</TableCell>
									<TableCell className="align-top text-sm">
										{entry.user ?? "—"}
									</TableCell>
									<TableCell className="align-top">
										<div className="flex flex-col gap-1">
											{entry.managed ? (
												<Badge variant="green" className="w-fit">
													Dokploy
												</Badge>
											) : (
												<span className="text-xs">
													{SOURCE_LABEL[entry.source]}
												</span>
											)}
											<span
												className="truncate font-mono text-[11px] text-muted-foreground"
												title={entry.origin}
											>
												{entry.origin}
											</span>
										</div>
									</TableCell>
									<TableCell className="align-top text-right">
										{entry.managed && entry.managedId && (
											<DialogAction
												title="Remove this cron job?"
												description={`It is removed from ${entry.origin} on this server.`}
												type="destructive"
												onClick={async () => {
													try {
														await remove.mutateAsync({
															serverId,
															managedId: entry.managedId as string,
														});
														toast.success("Cron job removed");
														await refetch();
													} catch (err) {
														toast.error(
															err instanceof Error
																? err.message
																: "Could not remove the cron job",
														);
													}
												}}
											>
												<Button
													variant="ghost"
													size="icon-sm"
													aria-label="Remove"
													title="Remove"
												>
													<Trash2 className="text-destructive" />
												</Button>
											</DialogAction>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				</div>
			)}
		</div>
	);
};

const AddHostCron = ({
	serverId,
	onAdded,
}: {
	serverId: string;
	onAdded: () => void;
}) => {
	const [open, setOpen] = useState(false);
	const [name, setName] = useState("");
	const [schedule, setSchedule] = useState("0 3 * * *");
	const [user, setUser] = useState("root");
	const [command, setCommand] = useState("");
	const add = api.fleet.cron.add.useMutation();

	const submit = async () => {
		try {
			await add.mutateAsync({ serverId, name, schedule, user, command });
			toast.success("Cron job added");
			setOpen(false);
			setName("");
			setCommand("");
			onAdded();
		} catch (err) {
			toast.error(
				err instanceof Error ? err.message : "Could not add the cron job",
			);
		}
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button size="sm">
					<Plus className="size-4" />
					Add cron job
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Add a cron job</DialogTitle>
					<DialogDescription>
						Runs on this server through cron, from /etc/cron.d/dokploy.
					</DialogDescription>
				</DialogHeader>
				<div className="grid gap-4">
					<div className="grid gap-1.5">
						<Label htmlFor="cron-name">Name</Label>
						<Input
							id="cron-name"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Nightly cleanup"
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="cron-schedule">Schedule</Label>
						<Input
							id="cron-schedule"
							value={schedule}
							onChange={(event) => setSchedule(event.target.value)}
							className="font-mono"
						/>
						<div className="flex flex-wrap gap-1">
							{commonCronExpressions
								.filter((preset) => preset.value !== "custom")
								.map((preset) => (
									<button
										key={preset.value}
										type="button"
										onClick={() => setSchedule(preset.value)}
										className="rounded-md border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
									>
										{preset.label}
									</button>
								))}
						</div>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="cron-user">Run as</Label>
						<Input
							id="cron-user"
							value={user}
							onChange={(event) => setUser(event.target.value)}
							className="w-40"
						/>
					</div>
					<div className="grid gap-1.5">
						<Label htmlFor="cron-command" className="flex items-center gap-2">
							Command
							<InfoTooltip content="One line, run by /bin/sh. cron reads a bare % as a newline, so write \% when you mean a percent sign." />
						</Label>
						<Input
							id="cron-command"
							value={command}
							onChange={(event) => setCommand(event.target.value)}
							placeholder="docker system prune -f"
							className="font-mono"
						/>
					</div>
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button
						onClick={submit}
						isLoading={add.isPending}
						disabled={!command.trim() || !schedule.trim()}
					>
						Add
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
