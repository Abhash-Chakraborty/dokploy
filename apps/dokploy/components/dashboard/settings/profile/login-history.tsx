import { Globe, Monitor } from "lucide-react";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { api } from "@/utils/api";

const formatDate = (date: Date | string | null | undefined) => {
	if (!date) return "—";
	try {
		return new Date(date).toLocaleString();
	} catch {
		return "—";
	}
};

/**
 * Read-only list of the user's recent login sessions with IP and device.
 * Sourced from the Better Auth session table via user.getLoginHistory.
 */
export const LoginHistory = () => {
	const { data: history, isLoading } = api.user.getLoginHistory.useQuery();

	return (
		<Card className="bg-transparent">
			<CardHeader>
				<CardTitle className="text-xl flex flex-row gap-2 items-center">
					<Globe className="size-5 text-muted-foreground" />
					Login History
				</CardTitle>
				<CardDescription>
					Recent sessions for your account, including IP address and device.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<p className="text-sm text-muted-foreground">Loading…</p>
				) : !history || history.length === 0 ? (
					<p className="text-sm text-muted-foreground">No login history yet.</p>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>IP Address</TableHead>
								<TableHead>Device</TableHead>
								<TableHead>Signed in</TableHead>
								<TableHead className="text-right">Status</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{history.map((entry) => (
								<TableRow key={entry.id}>
									<TableCell className="font-mono text-xs">
										{entry.ipAddress || "—"}
									</TableCell>
									<TableCell className="max-w-[280px] truncate text-muted-foreground">
										<span className="flex items-center gap-2">
											<Monitor className="size-3.5 shrink-0" />
											<span className="truncate">{entry.userAgent || "—"}</span>
										</span>
									</TableCell>
									<TableCell className="whitespace-nowrap text-muted-foreground">
										{formatDate(entry.createdAt)}
									</TableCell>
									<TableCell className="text-right">
										{entry.isCurrent ? (
											<span className="text-xs font-medium text-green-500">
												Current
											</span>
										) : (
											<span className="text-xs text-muted-foreground">—</span>
										)}
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
			</CardContent>
		</Card>
	);
};
