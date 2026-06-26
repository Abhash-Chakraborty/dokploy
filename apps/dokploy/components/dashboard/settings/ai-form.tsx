"use client";

import { BotIcon, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { HandleAi } from "./handle-ai";

export const AiForm = () => {
	const { data: aiConfigs, refetch, isPending } = api.ai.getAll.useQuery();
	const { mutateAsync, isPending: isRemoving } = api.ai.delete.useMutation();

	return (
		<PageContainer>
			<PageHeader
				title="AI Settings"
				description="Manage your AI configurations."
				icon={<BotIcon className="size-5" />}
				actions={aiConfigs && aiConfigs?.length > 0 ? <HandleAi /> : undefined}
			/>
			<div className="space-y-2">
				{isPending ? (
					<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
						<span>Loading...</span>
						<Loader2 className="animate-spin size-4" />
					</div>
				) : aiConfigs?.length === 0 ? (
					<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center rounded-lg border border-dashed">
						<BotIcon className="size-8 self-center text-muted-foreground" />
						<span className="text-base text-muted-foreground text-center">
							You don't have any AI configurations
						</span>
						<HandleAi />
					</div>
				) : (
					<div className="flex flex-col gap-2 min-h-[25vh]">
						{aiConfigs?.map((config) => (
							<div
								key={config.aiId}
								className="flex items-center justify-between rounded-lg border bg-background px-4 py-3"
							>
								<div>
									<span className="text-sm font-medium">{config.name}</span>
									<p className="text-sm text-muted-foreground">
										{config.model}
									</p>
								</div>
								<div className="flex justify-between items-center">
									<HandleAi aiId={config.aiId} />
									<DialogAction
										title="Delete AI"
										description="Are you sure you want to delete this AI?"
										type="destructive"
										onClick={async () => {
											await mutateAsync({
												aiId: config.aiId,
											})
												.then(() => {
													toast.success("AI deleted successfully");
													refetch();
												})
												.catch(() => {
													toast.error("Error deleting AI");
												});
										}}
									>
										<Button
											variant="ghost"
											size="icon"
											className="group hover:bg-red-500/10 "
											isLoading={isRemoving}
										>
											<Trash2 className="size-4 text-primary group-hover:text-red-500" />
										</Button>
									</DialogAction>
								</div>
							</div>
						))}
					</div>
				)}
			</div>
		</PageContainer>
	);
};
