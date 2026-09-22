import type { IUpdateData } from "@dokploy/server/index";
import {
	ArrowRight,
	CircleArrowUp,
	CircleCheck,
	Download,
	FileText,
	PackagePlus,
	RefreshCcw,
	Server,
	ShieldCheck,
	X,
} from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { ToggleAutoCheckUpdates } from "./toggle-auto-check-updates";
import { UpdateWebServer } from "./update-webserver";

interface Props {
	updateData?: IUpdateData;
	children?: React.ReactNode;
	isOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
}

export const UpdateServer = ({
	updateData,
	children,
	isOpen: isOpenProp,
	onOpenChange: onOpenChangeProp,
}: Props) => {
	const [hasCheckedUpdate, setHasCheckedUpdate] = useState(!!updateData);
	const [isUpdateAvailable, setIsUpdateAvailable] = useState(
		!!updateData?.updateAvailable,
	);
	const { mutateAsync: getUpdateData, isPending } =
		api.settings.getUpdateData.useMutation();
	const { data: dokployVersion } = api.settings.getDokployVersion.useQuery();
	const { data: releaseTag } = api.settings.getReleaseTag.useQuery();
	const [latestVersion, setLatestVersion] = useState(
		updateData?.latestVersion ?? "",
	);
	const [isOpenInternal, setIsOpenInternal] = useState(false);

	const handleCheckUpdates = async () => {
		try {
			const updateData = await getUpdateData();
			const versionToUpdate = updateData.latestVersion || "";
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(updateData.updateAvailable);
			setLatestVersion(versionToUpdate);

			if (updateData.updateAvailable) {
				toast.success(versionToUpdate, {
					description: "New version available!",
				});
			} else {
				toast.info("No updates available");
			}
		} catch (error) {
			console.error("Error checking for updates:", error);
			setHasCheckedUpdate(true);
			setIsUpdateAvailable(false);
			toast.error(
				"An error occurred while checking for updates, please try again.",
			);
		}
	};

	const isOpen = isOpenInternal || isOpenProp;
	const onOpenChange = (open: boolean) => {
		setIsOpenInternal(open);
		onOpenChangeProp?.(open);
	};

	return (
		<Dialog open={isOpen} onOpenChange={onOpenChange}>
			<DialogTrigger asChild>
				{children ? (
					children
				) : (
					<TooltipProvider delayDuration={0}>
						<Tooltip>
							<TooltipTrigger asChild>
								<Button
									variant={updateData ? "outline" : "secondary"}
									size="sm"
									onClick={() => onOpenChange?.(true)}
								>
									<Download className="h-4 w-4 shrink-0" />
									{updateData ? (
										<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
											Update Available
										</span>
									) : (
										<span className="font-medium truncate group-data-[collapsible=icon]:hidden">
											Check for updates
										</span>
									)}
									{updateData && (
										<span className="absolute right-2 flex h-2 w-2 group-data-[collapsible=icon]:hidden">
											<span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
											<span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500" />
										</span>
									)}
								</Button>
							</TooltipTrigger>
							{updateData && (
								<TooltipContent side="right" sideOffset={10}>
									<p>Update Available</p>
								</TooltipContent>
							)}
						</Tooltip>
					</TooltipProvider>
				)}
			</DialogTrigger>
			<DialogContent className="max-w-md gap-5" showCloseButton={false}>
				<div className="flex items-start gap-3">
					<div className="flex size-10 shrink-0 items-center justify-center rounded-full border bg-muted/40">
						<CircleArrowUp className="size-5 text-emerald-500" />
					</div>
					<div className="min-w-0 flex-1">
						<DialogTitle className="text-lg font-semibold">
							Update Dokploy
						</DialogTitle>
						<DialogDescription className="text-sm">
							{isPending
								? "Checking published releases and their images..."
								: isUpdateAvailable
									? "A new release is ready to install."
									: hasCheckedUpdate
										? "You are on the latest release."
										: "Check for a newer release of this server."}
						</DialogDescription>
					</div>
					<DialogClose asChild>
						<Button variant="ghost" size="icon-sm" className="-mt-1 -mr-1">
							<X />
							<span className="sr-only">Close</span>
						</Button>
					</DialogClose>
				</div>

				<div className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-sm">
					<Server className="size-4 text-muted-foreground" />
					<span className="text-muted-foreground">Installed</span>
					<span className="font-mono text-xs">
						{dokployVersion ?? "…"}
						{(releaseTag === "canary" || releaseTag === "feature") &&
							` (${releaseTag})`}
					</span>
					{isUpdateAvailable && latestVersion && (
						<>
							<ArrowRight className="size-3.5 text-muted-foreground" />
							<span className="rounded-md bg-emerald-500/10 px-1.5 py-0.5 font-mono text-xs text-emerald-600 dark:text-emerald-400">
								{latestVersion}
							</span>
						</>
					)}
					{isPending && (
						<RefreshCcw className="ml-auto size-3.5 animate-spin text-muted-foreground" />
					)}
					{hasCheckedUpdate && !isUpdateAvailable && !isPending && (
						<CircleCheck className="ml-auto size-4 text-emerald-500" />
					)}
				</div>

				{isUpdateAvailable && (
					<ul className="space-y-2 text-sm text-muted-foreground">
						<li className="flex items-center gap-2.5">
							<PackagePlus className="size-4 shrink-0" />
							New features and improvements
						</li>
						<li className="flex items-center gap-2.5">
							<ShieldCheck className="size-4 shrink-0" />
							Bug and security fixes
						</li>
						<li className="flex items-center gap-2.5">
							<FileText className="size-4 shrink-0" />
							<span>
								Read the{" "}
								<Link
									href="https://github.com/Abhash-Chakraborty/dokploy/releases"
									target="_blank"
									className="text-foreground underline underline-offset-2"
								>
									release notes
								</Link>{" "}
								for breaking changes first
							</span>
						</li>
					</ul>
				)}

				<div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
					<ToggleAutoCheckUpdates disabled={isPending} />
					<div className="flex items-center gap-2">
						<Button
							variant="outline"
							size="sm"
							onClick={() => onOpenChange?.(false)}
						>
							Cancel
						</Button>
						{isUpdateAvailable ? (
							<UpdateWebServer buttonClassName="w-auto" buttonSize="sm" />
						) : (
							<Button
								size="sm"
								variant="secondary"
								onClick={handleCheckUpdates}
								isLoading={isPending}
							>
								{!isPending && <RefreshCcw className="size-4" />}
								{isPending ? "Checking" : "Check for updates"}
							</Button>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
};

export default UpdateServer;
