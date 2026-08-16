import { CircleCheck, CircleX, Loader2, ShieldQuestion } from "lucide-react";
import { useState } from "react";
import { AlertBlock } from "@/components/shared/alert-block";
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
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

type DrillDatabaseType = "postgres" | "mysql" | "mariadb";

interface Props {
	databaseId: string;
	databaseType: string;
	destinationId: string;
	serverId?: string | null;
}

const SUPPORTED: DrillDatabaseType[] = ["postgres", "mysql", "mariadb"];

/**
 * Restores a backup into a throwaway database and reports whether it actually
 * worked. Nothing here touches the live database — the whole point is to find
 * out before you need to know.
 */
export const VerifyBackup = ({
	databaseId,
	databaseType,
	destinationId,
	serverId,
}: Props) => {
	const [open, setOpen] = useState(false);
	const [file, setFile] = useState<string>("");

	const supported = SUPPORTED.includes(databaseType as DrillDatabaseType);

	const { data: files = [], isPending: filesPending } =
		api.backup.listBackupFiles.useQuery(
			{ destinationId, search: "", serverId: serverId ?? "" },
			{ enabled: open && !!destinationId && supported },
		);

	const { mutateAsync, data, isPending, reset } =
		api.backup.restoreDrill.useMutation();

	const run = async () => {
		if (!file) return;
		try {
			await mutateAsync({
				databaseId,
				databaseType: databaseType as DrillDatabaseType,
				destinationId,
				backupFile: file,
			});
		} catch {
			// Surfaced through the mutation's error state below.
		}
	};

	if (!supported) return null;

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				setOpen(next);
				if (next) reset();
			}}
		>
			<DialogTrigger asChild>
				<Button variant="outline">
					<ShieldQuestion className="size-4" />
					Verify
				</Button>
			</DialogTrigger>
			<DialogContent className="sm:max-w-xl">
				<DialogHeader>
					<DialogTitle>Verify a backup</DialogTitle>
					<DialogDescription>
						Restores the backup into a throwaway database beside the live one,
						counts what landed, then drops it. Your data is not touched.
					</DialogDescription>
				</DialogHeader>

				<div className="flex flex-col gap-3">
					<div className="flex flex-col gap-1.5">
						<Label>Backup file</Label>
						<Select value={file} onValueChange={setFile}>
							<SelectTrigger>
								<SelectValue
									placeholder={
										filesPending ? "Loading backups…" : "Choose a backup"
									}
								/>
							</SelectTrigger>
							<SelectContent>
								{files.map((entry) => (
									<SelectItem key={entry.Path} value={entry.Path}>
										{entry.Name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</div>

					{isPending && (
						<div className="flex min-h-[12vh] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-5 animate-spin" />
							<span>Restoring into a scratch database…</span>
						</div>
					)}

					{!isPending && data && (
						<AlertBlock type={data.passed ? "success" : "error"}>
							<span className="flex items-start gap-2">
								{data.passed ? (
									<CircleCheck className="mt-0.5 size-4 shrink-0" />
								) : (
									<CircleX className="mt-0.5 size-4 shrink-0" />
								)}
								<span className="flex flex-col gap-1">
									<span>{data.detail}</span>
									{data.durationMs ? (
										<span className="text-xs opacity-80">
											Took {(data.durationMs / 1000).toFixed(1)}s. Scratch
											database dropped.
										</span>
									) : null}
								</span>
							</span>
						</AlertBlock>
					)}
				</div>

				<DialogFooter>
					<Button onClick={run} disabled={!file} isLoading={isPending}>
						Run drill
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
