import { Database, FolderUp, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { HandleDestinations } from "./handle-destinations";

export const ShowDestinations = () => {
	const { data, isPending, refetch } = api.destination.all.useQuery();
	const { mutateAsync, isPending: isRemoving } =
		api.destination.remove.useMutation();
	const { data: permissions } = api.user.getPermissions.useQuery();
	return (
		<PageContainer>
			<PageHeader
				title="S3 Destinations"
				description="AWS S3, Cloudflare R2, Wasabi, DigitalOcean Spaces and more."
				icon={<Database className="size-5" />}
				actions={
					permissions?.destination.create ? <HandleDestinations /> : undefined
				}
			/>

			{isPending ? (
				<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
					<span>Loading...</span>
					<Loader2 className="animate-spin size-4" />
				</div>
			) : data?.length === 0 ? (
				<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center rounded-lg border border-dashed">
					<FolderUp className="size-8 self-center text-muted-foreground" />
					<span className="text-base text-muted-foreground">
						To create a backup it is required to set at least 1 provider.
					</span>
					{permissions?.destination.create && <HandleDestinations />}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{data?.map((destination, index) => (
						<div
							key={destination.destinationId}
							className="flex items-center justify-between rounded-lg border bg-background px-4 py-3"
						>
							<div className="flex flex-col gap-1">
								<span className="text-sm font-medium">
									{index + 1}. {destination.name}
								</span>
								<span className="text-xs text-muted-foreground">
									Created at:{" "}
									{new Date(destination.createdAt).toLocaleDateString()}
								</span>
							</div>
							<div className="flex flex-row gap-1">
								<HandleDestinations destinationId={destination.destinationId} />
								{permissions?.destination.delete && (
									<DialogAction
										title="Delete Destination"
										description="Are you sure you want to delete this destination?"
										type="destructive"
										onClick={async () => {
											await mutateAsync({
												destinationId: destination.destinationId,
											})
												.then(() => {
													toast.success("Destination deleted successfully");
													refetch();
												})
												.catch(() => {
													toast.error("Error deleting destination");
												});
										}}
									>
										<Button
											variant="ghost"
											size="icon"
											className="group hover:bg-red-500/10"
											isLoading={isRemoving}
										>
											<Trash2 className="size-4 text-primary group-hover:text-red-500" />
										</Button>
									</DialogAction>
								)}
							</div>
						</div>
					))}
				</div>
			)}
		</PageContainer>
	);
};
