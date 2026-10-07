import copy from "copy-to-clipboard";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { api } from "@/utils/api";
import { LiveStatus } from "./live-status";

interface Props {
	icon: ReactNode;
	name?: string;
	description?: string | null;
	appName?: string;
	storedStatus?: string | null;
	serverId?: string | null;
	server?: {
		name: string;
		ipAddress: string;
		serverStatus?: string | null;
	} | null;
	/** Edit, transfer, delete and similar, rendered top right. */
	actions?: ReactNode;
	/** Status of something other than a single Swarm service, e.g. a stack. */
	status?: ReactNode;
	logsHref?: string;
}

export const ServiceHeader = ({
	icon,
	name,
	description,
	appName,
	storedStatus,
	serverId,
	server,
	actions,
	status,
	logsHref,
}: Props) => {
	const { data: serverIp } = api.settings.getIp.useQuery();
	const ip = server?.ipAddress || serverIp;

	return (
		<div className="flex flex-col gap-3 pt-2 pb-1">
			<div className="flex flex-wrap items-start gap-x-4 gap-y-3">
				<div className="flex min-w-0 flex-col gap-1.5">
					<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
						<span className="text-muted-foreground [&_svg]:size-5">{icon}</span>
						<h1 className="truncate text-2xl font-semibold tracking-tight">
							{name}
						</h1>
						{status ?? (
							<LiveStatus
								appName={appName}
								serverId={serverId}
								storedStatus={storedStatus}
								logsHref={logsHref}
							/>
						)}
					</div>
					<div className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
						<span className="font-mono">{appName}</span>
						<span aria-hidden>·</span>
						<button
							type="button"
							className="hover:text-foreground"
							title="Copy server IP"
							onClick={() => {
								if (!ip) return;
								copy(ip);
								toast.success("Server IP copied");
							}}
						>
							{server?.name || "Dokploy server"}
						</button>
						{description && (
							<>
								<span aria-hidden>·</span>
								<span className="truncate">{description}</span>
							</>
						)}
					</div>
				</div>
				{actions && (
					<div className="ml-auto flex items-center gap-1">{actions}</div>
				)}
			</div>
			{server?.serverStatus === "inactive" && (
				<p className="flex items-center gap-2 text-[13px] text-muted-foreground">
					<TriangleAlert className="size-4 text-status-restarting" />
					This server is inactive, so deploys are paused until it is
					reactivated.
				</p>
			)}
		</div>
	);
};
