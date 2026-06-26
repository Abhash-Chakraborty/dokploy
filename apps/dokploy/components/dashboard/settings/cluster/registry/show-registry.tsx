import { Loader2, Package, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { HandleRegistry } from "./handle-registry";

export const ShowRegistry = () => {
	const { mutateAsync, isPending: isRemoving } =
		api.registry.remove.useMutation();
	const { data, isPending, refetch } = api.registry.all.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();

	return (
		<PageContainer>
			<PageHeader
				title="Docker Registry"
				description="Manage your Docker Registry configurations."
				icon={<Package className="size-5" />}
				actions={permissions?.registry.create ? <HandleRegistry /> : undefined}
			/>

			{isPending ? (
				<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
					<span>Loading...</span>
					<Loader2 className="animate-spin size-4" />
				</div>
			) : data?.length === 0 ? (
				<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center rounded-lg border border-dashed">
					<Package className="size-8 self-center text-muted-foreground" />
					<span className="text-base text-muted-foreground text-center">
						You don't have any registry configurations
					</span>
					{permissions?.registry.create && <HandleRegistry />}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{data?.map((registry, index) => (
						<div
							key={registry.registryId}
							className="flex items-center justify-between rounded-lg border bg-background px-4 py-3"
						>
							<div className="flex gap-2 flex-col">
								<span className="text-sm font-medium">
									{index + 1}. {registry.registryName}
								</span>
								{registry.registryUrl && (
									<span className="text-xs text-muted-foreground">
										{registry.registryUrl}
									</span>
								)}
							</div>

							<div className="flex flex-row gap-1">
								<HandleRegistry registryId={registry.registryId} />
								{permissions?.registry.delete && (
									<DialogAction
										title="Delete Registry"
										description="Are you sure you want to delete this registry configuration?"
										type="destructive"
										onClick={async () => {
											await mutateAsync({ registryId: registry.registryId })
												.then(() => {
													toast.success(
														"Registry configuration deleted successfully",
													);
													refetch();
												})
												.catch(() => {
													toast.error("Error deleting registry configuration");
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
