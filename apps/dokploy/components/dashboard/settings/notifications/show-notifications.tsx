import { Bell, Loader2, Mail, PenBoxIcon, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import {
	DiscordIcon,
	GotifyIcon,
	LarkIcon,
	MattermostIcon,
	NtfyIcon,
	ResendIcon,
	SlackIcon,
	TeamsIcon,
	TelegramIcon,
} from "@/components/icons/notification-icons";
import { DialogAction } from "@/components/shared/dialog-action";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Button } from "@/components/ui/button";
import { api } from "@/utils/api";
import { HandleNotifications } from "./handle-notifications";

const NOTIFICATION_ICONS: Record<string, ReactNode> = {
	slack: <SlackIcon className="size-6" />,
	telegram: <TelegramIcon className="size-7" />,
	discord: <DiscordIcon className="size-7" />,
	email: <Mail className="size-6 text-muted-foreground" />,
	resend: <ResendIcon className="size-6 text-muted-foreground" />,
	gotify: <GotifyIcon className="size-6" />,
	ntfy: <NtfyIcon className="size-6" />,
	custom: <PenBoxIcon className="size-6 text-muted-foreground" />,
	lark: <LarkIcon className="size-7 text-muted-foreground" />,
	teams: <TeamsIcon className="size-7 text-muted-foreground" />,
	mattermost: <MattermostIcon className="size-7" />,
};

export const ShowNotifications = () => {
	const { data, isPending, refetch } = api.notification.all.useQuery();
	const { mutateAsync, isPending: isRemoving } =
		api.notification.remove.useMutation();
	const { data: permissions } = api.user.getPermissions.useQuery();

	return (
		<PageContainer>
			<PageHeader
				title="Notifications"
				description="Discord, Slack, Telegram, Teams, Email, Resend, Lark and more."
				icon={<Bell className="size-5" />}
				actions={
					permissions?.notification.create ? <HandleNotifications /> : undefined
				}
			/>

			{isPending ? (
				<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
					<span>Loading...</span>
					<Loader2 className="animate-spin size-4" />
				</div>
			) : data?.length === 0 ? (
				<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center rounded-lg border border-dashed">
					<Bell className="text-muted-foreground" />
					<span className="text-base text-muted-foreground text-center">
						To send notifications it is required to set at least 1 provider.
					</span>
					{permissions?.notification.create && <HandleNotifications />}
				</div>
			) : (
				<div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{data?.map((notification) => (
						<div
							key={notification.notificationId}
							className="flex flex-col gap-3 rounded-xl border bg-background p-4 transition-colors hover:bg-muted/40"
						>
							<div className="flex items-start justify-between gap-2">
								<div className="flex size-11 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
									{NOTIFICATION_ICONS[notification.notificationType] ?? (
										<Bell className="size-6 text-muted-foreground" />
									)}
								</div>
								<div className="flex flex-row gap-1">
									<HandleNotifications
										notificationId={notification.notificationId}
									/>
									{permissions?.notification.delete && (
										<DialogAction
											title="Delete Notification"
											description="Are you sure you want to delete this notification?"
											type="destructive"
											onClick={async () => {
												await mutateAsync({
													notificationId: notification.notificationId,
												})
													.then(() => {
														toast.success("Notification deleted successfully");
														refetch();
													})
													.catch(() => {
														toast.error("Error deleting notification");
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
							<div className="flex flex-col gap-0.5 min-w-0">
								<span className="truncate text-sm font-medium">
									{notification.name}
								</span>
								<span className="text-xs capitalize text-muted-foreground">
									{notification.notificationType}
								</span>
							</div>
						</div>
					))}
				</div>
			)}
		</PageContainer>
	);
};
