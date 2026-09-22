import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { badgeStateColor } from "@/components/dashboard/application/logs/show";
import { resolveContainerSelection } from "@/components/dashboard/docker/logs/utils";
import { Badge } from "@/components/ui/badge";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
export const DockerLogs = dynamic(
	() =>
		import("@/components/dashboard/docker/logs/docker-logs-id").then(
			(e) => e.DockerLogsId,
		),
	{
		ssr: false,
	},
);

interface Props {
	appName: string;
	serverId?: string;
	appType: "stack" | "docker-compose";
	serviceId?: string;
}

export const ShowDockerLogsCompose = ({
	appName,
	appType,
	serverId,
	serviceId,
}: Props) => {
	const { data, isPending } = api.docker.getContainersByAppNameMatch.useQuery(
		{
			appName,
			appType,
			serverId,
		},
		{
			enabled: !!appName,
			refetchInterval: 5000,
		},
	);
	const [containerId, setContainerId] = useState<string | undefined>();

	useEffect(() => {
		setContainerId((currentContainerId) =>
			resolveContainerSelection(currentContainerId, data),
		);
	}, [data]);

	return (
		<DockerLogs
			serverId={serverId || ""}
			containerId={containerId || "select-a-container"}
			runType="native"
			serviceId={serviceId}
			toolbarStart={
				<Select onValueChange={setContainerId} value={containerId}>
					<SelectTrigger
						size="sm"
						className="h-8 w-full min-w-0 text-xs sm:w-72 [&>span]:truncate"
						aria-label="Container"
					>
						{isPending ? (
							<div className="flex flex-row gap-2 items-center text-muted-foreground">
								<Loader2 className="animate-spin size-3.5" />
								<span>Loading...</span>
							</div>
						) : (
							<SelectValue placeholder="Select a container" />
						)}
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectLabel>Containers ({data?.length ?? 0})</SelectLabel>
							{data?.map((container) => (
								<SelectItem
									key={container.containerId}
									value={container.containerId}
								>
									{container.name} ({container.containerId}){" "}
									<Badge variant={badgeStateColor(container.state)}>
										{container.state}
									</Badge>
									{container.status ? ` ${container.status}` : ""}
								</SelectItem>
							))}
						</SelectGroup>
					</SelectContent>
				</Select>
			}
		/>
	);
};
