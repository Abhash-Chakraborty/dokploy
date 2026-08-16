import {
	AlertTriangle,
	Boxes,
	Database,
	HardDrive,
	Layers,
	Loader2,
	type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { api } from "@/utils/api";

type Scope = "containers" | "images" | "volumes" | "builders";

const SCOPES: {
	key: Scope;
	label: string;
	blurb: string;
	icon: LucideIcon;
	destructive?: boolean;
}[] = [
	{
		key: "containers",
		label: "Stopped containers",
		blurb: "Containers that aren't running.",
		icon: Boxes,
	},
	{
		key: "images",
		label: "Unused images",
		blurb: "Images with no container attached.",
		icon: Layers,
	},
	{
		key: "volumes",
		label: "Unused volumes",
		blurb: "Volumes nothing links to. These can hold real data.",
		icon: Database,
		destructive: true,
	},
	{
		key: "builders",
		label: "Build cache",
		blurb: "Cached build layers that aren't in use.",
		icon: HardDrive,
	},
];

const formatBytes = (bytes: number) => {
	if (!bytes) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const exponent = Math.min(
		Math.floor(Math.log(bytes) / Math.log(1024)),
		units.length - 1,
	);
	const value = bytes / 1024 ** exponent;
	return `${value >= 10 || exponent === 0 ? Math.round(value) : value.toFixed(1)} ${units[exponent]}`;
};

interface Props {
	serverId?: string;
	children?: React.ReactNode;
}

/**
 * Docker has no `--dry-run` for prune, and the previous menu deleted
 * immediately on click — including volumes, which can hold real data. This
 * shows exactly what each scope would remove before anything is deleted.
 */
export const ReclaimSpaceDialog = ({ serverId, children }: Props) => {
	const [open, setOpen] = useState(false);
	const [selected, setSelected] = useState<Scope[]>([
		"containers",
		"images",
		"builders",
	]);

	const {
		data: preview,
		isPending,
		isFetching,
		refetch,
	} = api.settings.getPrunePreview.useQuery({ serverId }, { enabled: open });

	const cleanStoppedContainers =
		api.settings.cleanStoppedContainers.useMutation();
	const cleanUnusedImages = api.settings.cleanUnusedImages.useMutation();
	const cleanUnusedVolumes = api.settings.cleanUnusedVolumes.useMutation();
	const cleanDockerBuilder = api.settings.cleanDockerBuilder.useMutation();

	const [isRunning, setIsRunning] = useState(false);

	const byScope = (scope: Scope) =>
		preview?.scopes.find((entry) => entry.scope === scope);

	const selectedBytes = selected.reduce(
		(sum, scope) => sum + (byScope(scope)?.reclaimableBytes ?? 0),
		0,
	);
	const selectedItems = selected.reduce(
		(sum, scope) => sum + (byScope(scope)?.itemCount ?? 0),
		0,
	);

	const toggle = (scope: Scope) =>
		setSelected((current) =>
			current.includes(scope)
				? current.filter((entry) => entry !== scope)
				: [...current, scope],
		);

	const run = async () => {
		setIsRunning(true);
		const runners: Record<Scope, () => Promise<unknown>> = {
			containers: () => cleanStoppedContainers.mutateAsync({ serverId }),
			images: () => cleanUnusedImages.mutateAsync({ serverId }),
			volumes: () => cleanUnusedVolumes.mutateAsync({ serverId }),
			builders: () => cleanDockerBuilder.mutateAsync({ serverId }),
		};

		const failed: Scope[] = [];
		for (const scope of selected) {
			try {
				await runners[scope]();
			} catch {
				failed.push(scope);
			}
		}
		setIsRunning(false);

		if (failed.length === 0) {
			toast.success(`Reclaimed about ${formatBytes(selectedBytes)}`);
			setOpen(false);
		} else {
			toast.error(`Could not clean: ${failed.join(", ")}`);
		}
		await refetch();
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				{children ?? <Button variant="outline">Reclaim space</Button>}
			</DialogTrigger>
			<DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>Reclaim space</DialogTitle>
					<DialogDescription>
						Nothing is deleted until you confirm. This is what Docker would
						remove on this host right now.
					</DialogDescription>
				</DialogHeader>

				{isPending ? (
					<div className="flex min-h-[30vh] flex-row items-center justify-center gap-2 text-sm text-muted-foreground">
						<span>Checking what can be reclaimed…</span>
						<Loader2 className="size-4 animate-spin" />
					</div>
				) : preview?.error ? (
					<AlertBlock type="error">{preview.error}</AlertBlock>
				) : (
					<div className="flex flex-col gap-3">
						{SCOPES.map((scope) => {
							const result = byScope(scope.key);
							const count = result?.itemCount ?? 0;
							const isSelected = selected.includes(scope.key);
							const Icon = scope.icon;

							return (
								<div
									key={scope.key}
									className="flex flex-col gap-2 rounded-lg border p-3"
								>
									<label className="flex cursor-pointer items-start gap-3">
										<Checkbox
											checked={isSelected}
											disabled={count === 0}
											onCheckedChange={() => toggle(scope.key)}
											className="mt-1"
										/>
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<div className="flex flex-wrap items-center gap-2">
												<Icon className="size-4 text-muted-foreground" />
												<span className="text-sm font-medium">
													{scope.label}
												</span>
												<span className="text-xs text-muted-foreground tabular-nums">
													{count} item{count === 1 ? "" : "s"} ·{" "}
													{formatBytes(result?.reclaimableBytes ?? 0)}
												</span>
											</div>
											<span className="text-xs text-muted-foreground">
												{scope.blurb}
											</span>
										</div>
									</label>

									{isSelected && count > 0 && (
										<ul className="ml-8 flex max-h-36 flex-col gap-1 overflow-y-auto rounded-md bg-muted/50 p-2 font-mono text-xs">
											{result?.items.map((item) => (
												<li
													key={`${scope.key}-${item.name}-${item.detail}`}
													className="flex items-baseline justify-between gap-3"
												>
													<span className="truncate" title={item.name}>
														{item.name}
													</span>
													<span className="shrink-0 text-muted-foreground tabular-nums">
														{item.size}
													</span>
												</li>
											))}
											{count > (result?.items.length ?? 0) && (
												<li className="text-muted-foreground">
													…and {count - (result?.items.length ?? 0)} more
												</li>
											)}
										</ul>
									)}
								</div>
							);
						})}

						{selected.includes("volumes") &&
							(byScope("volumes")?.itemCount ?? 0) > 0 && (
								<AlertBlock type="warning">
									<span className="flex items-start gap-2">
										<AlertTriangle className="mt-0.5 size-4 shrink-0" />
										<span>
											Unused volumes often hold database data that no container
											happens to be attached to right now. Deleted volumes can't
											be recovered.
										</span>
									</span>
								</AlertBlock>
							)}
					</div>
				)}

				<DialogFooter className="gap-2 sm:justify-between">
					<span className="text-sm text-muted-foreground tabular-nums">
						{selectedItems} item{selectedItems === 1 ? "" : "s"} ·{" "}
						{formatBytes(selectedBytes)} selected
					</span>
					<div className="flex gap-2">
						<Button
							variant="ghost"
							onClick={() => refetch()}
							isLoading={isFetching && !isPending}
						>
							Re-check
						</Button>
						<Button
							variant="destructive"
							disabled={selectedItems === 0 || !!preview?.error}
							isLoading={isRunning}
							onClick={run}
						>
							Delete {selectedItems} item{selectedItems === 1 ? "" : "s"}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
};
