import { Database, HardDrive } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
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

type Filter = "all" | "active" | "inactive";

const serviceTypeOf = (b: {
	postgresId?: string | null;
	mysqlId?: string | null;
	mariadbId?: string | null;
	mongoId?: string | null;
	libsqlId?: string | null;
	composeId?: string | null;
}) => {
	if (b.postgresId) return "PostgreSQL";
	if (b.mysqlId) return "MySQL";
	if (b.mariadbId) return "MariaDB";
	if (b.mongoId) return "MongoDB";
	if (b.libsqlId) return "LibSQL";
	if (b.composeId) return "Compose";
	return "Database";
};

/**
 * Unified, read-only view of every backup in the organization across all
 * service types. Shows status, schedule, type and destination, with a status
 * filter. Editing happens on each service's own backup tab.
 */
export const UnifiedBackups = () => {
	const { data: backups, isLoading } = api.backup.listAll.useQuery();
	const [filter, setFilter] = useState<Filter>("all");

	const filtered = (backups ?? []).filter((b) => {
		if (filter === "active") return !!b.enabled;
		if (filter === "inactive") return !b.enabled;
		return true;
	});

	return (
		<div className="flex flex-col gap-4">
			<div className="flex items-center justify-end">
				<Select value={filter} onValueChange={(v) => setFilter(v as Filter)}>
					<SelectTrigger className="w-40">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">All backups</SelectItem>
						<SelectItem value="active">Active only</SelectItem>
						<SelectItem value="inactive">Inactive only</SelectItem>
					</SelectContent>
				</Select>
			</div>

			{isLoading ? (
				<p className="text-sm text-muted-foreground">Loading…</p>
			) : filtered.length === 0 ? (
				<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-12 text-center">
					<HardDrive className="size-8 text-muted-foreground" />
					<p className="text-sm text-muted-foreground">
						No backups configured yet.
					</p>
				</div>
			) : (
				<Table>
					<TableHeader>
						<TableRow>
							<TableHead>Type</TableHead>
							<TableHead>Database</TableHead>
							<TableHead>Schedule</TableHead>
							<TableHead>Destination</TableHead>
							<TableHead className="text-right">Status</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{filtered.map((b) => (
							<TableRow key={b.backupId}>
								<TableCell>
									<span className="flex items-center gap-2">
										<Database className="size-3.5 text-muted-foreground" />
										{serviceTypeOf(b)}
									</span>
								</TableCell>
								<TableCell className="text-muted-foreground">
									{b.database}
								</TableCell>
								<TableCell className="font-mono text-xs">
									{b.schedule}
								</TableCell>
								<TableCell className="text-muted-foreground">
									{b.destination?.name ?? "—"}
								</TableCell>
								<TableCell className="text-right">
									<Badge variant={b.enabled ? "default" : "secondary"}>
										{b.enabled ? "Active" : "Inactive"}
									</Badge>
								</TableCell>
							</TableRow>
						))}
					</TableBody>
				</Table>
			)}
		</div>
	);
};
