import { formatDistanceToNow } from "date-fns";
import { KeyRound, Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { HandleSSHKeys } from "./handle-ssh-keys";

export const ShowDestinations = () => {
	const { data, isPending, refetch } = api.sshKey.all.useQuery();
	const { mutateAsync, isPending: isRemoving } =
		api.sshKey.remove.useMutation();
	const { data: permissions } = api.user.getPermissions.useQuery();

	return (
		<PageContainer>
			<PageHeader
				title="SSH Keys"
				description="Access your servers, git private repositories, and more."
				icon={<KeyRound className="size-5" />}
				actions={permissions?.sshKeys.create ? <HandleSSHKeys /> : undefined}
			/>

			{isPending ? (
				<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
					<span>Loading...</span>
					<Loader2 className="animate-spin size-4" />
				</div>
			) : data?.length === 0 ? (
				<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center rounded-lg border border-dashed">
					<KeyRound className="size-8 self-center text-muted-foreground" />
					<span className="text-base text-muted-foreground text-center">
						You don't have any SSH keys
					</span>
					{permissions?.sshKeys.create && <HandleSSHKeys />}
				</div>
			) : (
				<div className="flex flex-col gap-2">
					{data?.map((sshKey, index) => (
						<div
							key={sshKey.sshKeyId}
							className="flex items-center justify-between rounded-lg border bg-background px-4 py-3"
						>
							<div className="flex flex-col">
								<span className="text-sm font-medium">
									{index + 1}. {sshKey.name}
								</span>
								{sshKey.description && (
									<span className="text-xs text-muted-foreground">
										{sshKey.description}
									</span>
								)}
								<span className="text-xs text-muted-foreground">
									Created{" "}
									{formatDistanceToNow(new Date(sshKey.createdAt), {
										addSuffix: true,
									})}
								</span>
							</div>

							<div className="flex flex-row gap-1">
								<HandleSSHKeys sshKeyId={sshKey.sshKeyId} />
								{permissions?.sshKeys.delete && (
									<DialogAction
										title="Delete SSH Key"
										description="Are you sure you want to delete this SSH Key?"
										type="destructive"
										onClick={async () => {
											await mutateAsync({ sshKeyId: sshKey.sshKeyId })
												.then(() => {
													toast.success("SSH Key deleted successfully");
													refetch();
												})
												.catch(() => {
													toast.error("Error deleting SSH Key");
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
