import copy from "copy-to-clipboard";
import { format } from "date-fns";
import {
	Clock,
	Copy,
	Key,
	KeyIcon,
	Loader2,
	Network,
	ServerIcon,
	Terminal,
	Trash2,
	User,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/router";
import { toast } from "sonner";
import { AlertBlock } from "@/components/shared/alert-block";
import { DialogAction } from "@/components/shared/dialog-action";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";
import { TerminalModal } from "../web-server/terminal-modal";
import { ShowServerActions } from "./actions/show-server-actions";
import { HandleServers } from "./handle-servers";
import { SetupServer } from "./setup-server";
import { ShowMonitoringModal } from "./show-monitoring-modal";
import { WelcomeSubscription } from "./welcome-stripe/welcome-subscription";

export const ShowServers = () => {
	const router = useRouter();
	const query = router.query;
	const { data, refetch, isPending } = api.server.all.useQuery();
	const { mutateAsync } = api.server.remove.useMutation();
	const { data: sshKeys } = api.sshKey.all.useQuery();
	const { data: isCloud } = api.settings.isCloud.useQuery();
	const { data: canCreateMoreServers } =
		api.stripe.canCreateMoreServers.useQuery();
	const { data: permissions } = api.user.getPermissions.useQuery();

	return (
		<PageContainer>
			{query?.success && isCloud && <WelcomeSubscription />}
			<PageHeader
				title="Servers"
				description="Add servers to deploy your applications remotely."
				icon={<ServerIcon className="size-5" />}
				actions={
					permissions?.server.create && data && data.length > 0 ? (
						<HandleServers />
					) : undefined
				}
			/>
			{isCloud && (
				<button
					type="button"
					className="bg-gradient-to-r cursor-pointer from-blue-600 via-green-500 to-indigo-400 inline-block text-transparent bg-clip-text text-sm w-fit"
					onClick={() => {
						router.push("/dashboard/settings/servers?success=true");
					}}
				>
					Reset Onboarding
				</button>
			)}
			<div className="space-y-2">
				{isPending ? (
					<div className="flex flex-row gap-2 items-center justify-center text-sm text-muted-foreground min-h-[25vh]">
						<span>Loading...</span>
						<Loader2 className="animate-spin size-4" />
					</div>
				) : (
					<>
						{sshKeys?.length === 0 && data?.length === 0 ? (
							<div className="flex flex-col items-center gap-3 min-h-[25vh] justify-center">
								<KeyIcon className="size-8" />
								<span className="text-base text-muted-foreground">
									No SSH Keys found. Add a SSH Key to start adding servers.{" "}
									<Link
										href="/dashboard/settings/ssh-keys"
										className="text-primary"
									>
										Add SSH Key
									</Link>
								</span>
							</div>
						) : (
							<>
								{data?.length === 0 ? (
									<div className="flex flex-col items-center gap-3  min-h-[25vh] justify-center">
										<ServerIcon className="size-8 self-center text-muted-foreground" />
										<span className="text-base text-muted-foreground">
											Start adding servers to deploy your applications remotely.
										</span>
										{permissions?.server.create && <HandleServers />}
									</div>
								) : (
									<div className="flex flex-col gap-4 min-h-[25vh]">
										<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
											{data?.map((server) => {
												const canDelete = server.totalSum === 0;
												const isActive = server.serverStatus === "active";
												const isBuildServer = server.serverType === "build";
												return (
													<Card
														key={server.serverId}
														className="relative hover:shadow-lg transition-shadow flex flex-col bg-transparent"
													>
														<CardHeader className="pb-3">
															<div className="flex items-start justify-between gap-2">
																<div className="flex min-w-0 items-center gap-2">
																	<ServerIcon className="size-5 shrink-0 text-muted-foreground" />
																	<CardTitle className="text-lg break-words min-w-0">
																		{server.name}
																	</CardTitle>
																</div>
															</div>
															<TooltipProvider>
																<div className="flex gap-2 mt-2 flex-wrap">
																	{isCloud && (
																		<>
																			{server.serverStatus === "active" ? (
																				<Badge variant="default">
																					{server.serverStatus}
																				</Badge>
																			) : (
																				<Tooltip delayDuration={0}>
																					<TooltipTrigger asChild>
																						<span className="inline-block">
																							<Badge
																								variant="destructive"
																								className="cursor-help"
																							>
																								{server.serverStatus}
																							</Badge>
																						</span>
																					</TooltipTrigger>
																					<TooltipContent
																						className="max-w-xs"
																						side="bottom"
																					>
																						<p className="text-sm">
																							This server is deactivated due to
																							lack of payment. Please pay your
																							invoice to reactivate it. If you
																							think this is an error, please
																							contact support.
																						</p>
																					</TooltipContent>
																				</Tooltip>
																			)}
																		</>
																	)}
																	<Badge
																		variant={
																			isBuildServer ? "secondary" : "default"
																		}
																	>
																		{server.serverType}
																	</Badge>
																</div>
															</TooltipProvider>
														</CardHeader>
														<CardContent className="space-y-3 flex-1 flex flex-col">
															<div className="flex items-center gap-2 text-sm">
																<Network className="size-4 text-muted-foreground" />
																<span className="text-muted-foreground">
																	IP:
																</span>
																<button
																	type="button"
																	onClick={() => {
																		copy(server.ipAddress);
																		toast.success("IP copied to clipboard");
																	}}
																	className="inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs hover:bg-muted transition-colors"
																	title="Copy IP"
																>
																	{server.ipAddress}
																	<Copy className="size-3" />
																</button>
																<span className="text-muted-foreground">
																	Port:
																</span>
																<span className="font-medium">
																	{server.port}
																</span>
															</div>
															<div className="flex items-center gap-2 text-sm">
																<User className="size-4 text-muted-foreground" />
																<span className="text-muted-foreground">
																	User:
																</span>
																<span className="font-medium">
																	{server.username}
																</span>
															</div>
															<div className="flex items-center gap-2 text-sm">
																<Key className="size-4 text-muted-foreground" />
																<span className="text-muted-foreground">
																	SSH Key:
																</span>
																<span className="font-medium">
																	{server.sshKeyId ? "Yes" : "No"}
																</span>
															</div>
															<div className="flex items-center gap-2 text-sm pt-2 border-t">
																<Clock className="size-4 text-muted-foreground" />
																<span className="text-xs text-muted-foreground">
																	Created{" "}
																	{format(new Date(server.createdAt), "PPp")}
																</span>
															</div>

															{/* Compact Actions */}
															{isActive && (
																<div className="flex items-center gap-2 pt-3 border-t mt-auto flex-wrap">
																	<TooltipProvider>
																		<Tooltip>
																			<TooltipTrigger asChild>
																				<SetupServer
																					serverId={server.serverId}
																				/>
																			</TooltipTrigger>
																			<TooltipContent
																				className="max-w-xs"
																				side="bottom"
																			>
																				<div className="space-y-1">
																					<p className="font-semibold">
																						Setup Server
																					</p>
																					<p className="text-xs text-muted-foreground">
																						Configure and initialize your server
																						with Docker, Traefik, and other
																						essential services
																					</p>
																				</div>
																			</TooltipContent>
																		</Tooltip>
																		{server.sshKeyId && (
																			<Tooltip>
																				<TooltipTrigger asChild>
																					<div>
																						<TerminalModal
																							serverId={server.serverId}
																							asButton={true}
																						>
																							<Button
																								variant="outline"
																								size="icon"
																								className="h-9 w-9"
																							>
																								<Terminal className="h-4 w-4" />
																							</Button>
																						</TerminalModal>
																					</div>
																				</TooltipTrigger>
																				<TooltipContent>
																					<p>Terminal</p>
																				</TooltipContent>
																			</Tooltip>
																		)}

																		<Tooltip>
																			<TooltipTrigger asChild>
																				<div>
																					<HandleServers
																						serverId={server.serverId}
																						asButton={true}
																					/>
																				</div>
																			</TooltipTrigger>
																			<TooltipContent>
																				<p>Edit Server</p>
																			</TooltipContent>
																		</Tooltip>

																		{server.sshKeyId && !isBuildServer && (
																			<Tooltip>
																				<TooltipTrigger asChild>
																					<div>
																						<ShowServerActions
																							serverId={server.serverId}
																							asButton={true}
																						/>
																					</div>
																				</TooltipTrigger>
																				<TooltipContent>
																					<p>Web Server Actions</p>
																				</TooltipContent>
																			</Tooltip>
																		)}

																		{isCloud &&
																			server.sshKeyId &&
																			!isBuildServer && (
																				<Tooltip>
																					<TooltipTrigger asChild>
																						<div>
																							<ShowMonitoringModal
																								url={`http://${server.ipAddress}:${server?.metricsConfig?.server?.port}/metrics`}
																								token={
																									server?.metricsConfig?.server
																										?.token
																								}
																							/>
																						</div>
																					</TooltipTrigger>
																					<TooltipContent>
																						<p>Monitoring</p>
																					</TooltipContent>
																				</Tooltip>
																			)}

																		<div className="flex-1" />

																		{permissions?.server.delete && (
																			<Tooltip>
																				<TooltipTrigger asChild>
																					<div>
																						<DialogAction
																							disabled={!canDelete}
																							title={
																								canDelete
																									? "Delete Server"
																									: "Server has active services"
																							}
																							description={
																								canDelete ? (
																									"This will delete the server and all associated data"
																								) : (
																									<div className="flex flex-col gap-2">
																										You can not delete this
																										server because it has active
																										services.
																										<AlertBlock type="warning">
																											You have active services
																											associated with this
																											server, please delete them
																											first.
																										</AlertBlock>
																									</div>
																								)
																							}
																							onClick={async () => {
																								await mutateAsync({
																									serverId: server.serverId,
																								})
																									.then(() => {
																										refetch();
																										toast.success(
																											`Server ${server.name} deleted successfully`,
																										);
																									})
																									.catch((err) => {
																										toast.error(err.message);
																									});
																							}}
																						>
																							<Button
																								variant="ghost"
																								size="icon"
																								className={`h-9 w-9 ${canDelete ? "text-destructive hover:text-destructive hover:bg-destructive/10" : "text-muted-foreground hover:bg-muted"}`}
																							>
																								<Trash2 className="h-4 w-4" />
																							</Button>
																						</DialogAction>
																					</div>
																				</TooltipTrigger>
																				<TooltipContent>
																					<p>
																						{canDelete
																							? "Delete Server"
																							: "Cannot delete - has active services"}
																					</p>
																				</TooltipContent>
																			</Tooltip>
																		)}
																	</TooltipProvider>
																</div>
															)}
														</CardContent>
													</Card>
												);
											})}
										</div>
									</div>
								)}
							</>
						)}
					</>
				)}
			</div>
		</PageContainer>
	);
};
