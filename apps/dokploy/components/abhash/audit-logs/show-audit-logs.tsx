import { formatDistanceToNow } from "date-fns";
import { Download, RefreshCw, Search, ShieldCheck } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

const ACTION_OPTIONS = [
	"all",
	"create",
	"update",
	"delete",
	"deploy",
	"cancel",
	"redeploy",
	"login",
	"logout",
	"restore",
	"run",
	"start",
	"stop",
	"reload",
	"rebuild",
	"move",
] as const;

const RESOURCE_OPTIONS = [
	"all",
	"project",
	"service",
	"environment",
	"deployment",
	"user",
	"domain",
	"registry",
	"server",
	"settings",
	"schedule",
	"backup",
	"volumeBackup",
	"docker",
	"organization",
	"application",
	"compose",
] as const;

const actionVariant = (action: string) => {
	if (["delete", "cancel", "stop"].includes(action)) return "red";
	if (["deploy", "redeploy", "start", "run", "restore"].includes(action)) {
		return "green";
	}
	if (["update", "move", "reload", "rebuild"].includes(action)) return "blue";
	return "blank";
};

const formatMetadata = (metadata: string | null) => {
	if (!metadata) return "";

	try {
		return JSON.stringify(JSON.parse(metadata), null, 2);
	} catch {
		return metadata;
	}
};

export const ShowAbhashAuditLogs = () => {
	const [page, setPage] = useState(1);
	const [search, setSearch] = useState("");
	const [action, setAction] = useState("all");
	const [resourceType, setResourceType] = useState("all");
	const limit = 25;

	const queryInput = useMemo(
		() => ({
			page,
			limit,
			search: search || undefined,
			action,
			resourceType,
		}),
		[page, search, action, resourceType],
	);

	const logs = api.auditLog.list.useQuery(queryInput);
	const summary = api.auditLog.summary.useQuery();

	const exportCsv = () => {
		const rows = logs.data?.rows ?? [];
		const header = [
			"createdAt",
			"userEmail",
			"userRole",
			"action",
			"resourceType",
			"resourceId",
			"resourceName",
			"metadata",
		];
		const csv = [
			header.join(","),
			...rows.map((row) =>
				header
					.map((key) => {
						const value = row[key as keyof typeof row];
						return `"${String(value ?? "").replaceAll('"', '""')}"`;
					})
					.join(","),
			),
		].join("\n");

		const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = "abhash-audit-logs.csv";
		link.click();
		URL.revokeObjectURL(url);
	};

	return (
		<div className="flex w-full flex-col gap-4">
			<div className="flex flex-col gap-3 rounded-lg border bg-card p-4">
				<div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
					<div className="flex items-center gap-3">
						<div className="flex h-10 w-10 items-center justify-center rounded-md border bg-background">
							<ShieldCheck className="h-5 w-5 text-muted-foreground" />
						</div>
						<div>
							<h1 className="font-semibold text-xl tracking-tight">
								Audit Logs
							</h1>
							<p className="text-muted-foreground text-sm">
								Abhash personal audit trail for organization activity.
							</p>
						</div>
					</div>
					<div className="flex flex-wrap gap-2">
						<Button
							type="button"
							variant="outline"
							onClick={() => {
								void logs.refetch();
								void summary.refetch();
							}}
						>
							<RefreshCw className="h-4 w-4" />
							Refresh
						</Button>
						<Button type="button" variant="outline" onClick={exportCsv}>
							<Download className="h-4 w-4" />
							Export CSV
						</Button>
					</div>
				</div>

				<div className="grid gap-3 md:grid-cols-3">
					<div className="rounded-md border bg-background p-3">
						<div className="text-muted-foreground text-xs">Total events</div>
						<div className="mt-1 font-semibold text-2xl">
							{summary.data?.total ?? 0}
						</div>
					</div>
					<div className="rounded-md border bg-background p-3">
						<div className="text-muted-foreground text-xs">Last 24 hours</div>
						<div className="mt-1 font-semibold text-2xl">
							{summary.data?.last24Hours ?? 0}
						</div>
					</div>
					<div className="rounded-md border bg-background p-3">
						<div className="text-muted-foreground text-xs">Top action</div>
						<div className="mt-2">
							<Badge variant="blue">
								{summary.data?.actions[0]?.action ?? "none"}
							</Badge>
						</div>
					</div>
				</div>

				<div className="grid gap-2 lg:grid-cols-[1fr_180px_220px]">
					<div className="relative">
						<Search className="-translate-y-1/2 absolute top-1/2 left-3 h-4 w-4 text-muted-foreground" />
						<Input
							className="pl-9"
							placeholder="Search user, action, resource, metadata..."
							value={search}
							onChange={(event) => {
								setPage(1);
								setSearch(event.target.value);
							}}
						/>
					</div>
					<Select
						value={action}
						onValueChange={(value) => {
							setPage(1);
							setAction(value);
						}}
					>
						<SelectTrigger>
							<SelectValue placeholder="Action" />
						</SelectTrigger>
						<SelectContent>
							{ACTION_OPTIONS.map((item) => (
								<SelectItem key={item} value={item}>
									{item === "all" ? "All actions" : item}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select
						value={resourceType}
						onValueChange={(value) => {
							setPage(1);
							setResourceType(value);
						}}
					>
						<SelectTrigger>
							<SelectValue placeholder="Resource" />
						</SelectTrigger>
						<SelectContent>
							{RESOURCE_OPTIONS.map((item) => (
								<SelectItem key={item} value={item}>
									{item === "all" ? "All resources" : item}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			<div className="rounded-lg border">
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead className="w-[170px]">Time</TableHead>
							<TableHead>User</TableHead>
							<TableHead>Action</TableHead>
							<TableHead>Resource</TableHead>
							<TableHead>Metadata</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{logs.isLoading ? (
							<TableRow>
								<TableCell colSpan={5} className="h-28 text-center">
									Loading audit trail...
								</TableCell>
							</TableRow>
						) : logs.data?.rows.length ? (
							logs.data.rows.map((row) => (
								<TableRow key={row.id}>
									<TableCell className="text-muted-foreground text-xs">
										{formatDistanceToNow(new Date(row.createdAt), {
											addSuffix: true,
										})}
									</TableCell>
									<TableCell>
										<div className="font-medium text-sm">{row.userEmail}</div>
										<div className="text-muted-foreground text-xs">
											{row.userRole}
										</div>
									</TableCell>
									<TableCell>
										<Badge variant={actionVariant(row.action)}>{row.action}</Badge>
									</TableCell>
									<TableCell>
										<div className="font-medium text-sm">{row.resourceType}</div>
										<div className="max-w-[260px] truncate text-muted-foreground text-xs">
											{row.resourceName || row.resourceId || "No resource detail"}
										</div>
									</TableCell>
									<TableCell>
										<pre className="max-h-24 max-w-[420px] overflow-auto whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs">
											{formatMetadata(row.metadata) || "No metadata"}
										</pre>
									</TableCell>
								</TableRow>
							))
						) : (
							<TableRow>
								<TableCell colSpan={5} className="h-28 text-center">
									No audit events match these filters.
								</TableCell>
							</TableRow>
						)}
					</TableBody>
				</Table>
			</div>

			<div className="flex flex-col gap-2 text-muted-foreground text-sm sm:flex-row sm:items-center sm:justify-between">
				<div>
					Page {logs.data?.page ?? page} of {logs.data?.totalPages ?? 1} ·{" "}
					{logs.data?.total ?? 0} events
				</div>
				<div className="flex gap-2">
					<Button
						type="button"
						variant="outline"
						disabled={page <= 1 || logs.isFetching}
						onClick={() => setPage((current) => Math.max(1, current - 1))}
					>
						Previous
					</Button>
					<Button
						type="button"
						variant="outline"
						disabled={
							logs.isFetching || page >= (logs.data?.totalPages ?? 1)
						}
						onClick={() => setPage((current) => current + 1)}
					>
						Next
					</Button>
				</div>
			</div>
		</div>
	);
};
