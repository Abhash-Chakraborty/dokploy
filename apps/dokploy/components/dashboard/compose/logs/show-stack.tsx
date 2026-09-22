import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { ContainerPicker } from "@/components/dashboard/application/logs/show";
import { resolveContainerSelection } from "@/components/dashboard/docker/logs/utils";
import { AlertBlock } from "@/components/shared/alert-block";
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
	serviceId?: string;
}

export const ShowDockerLogsStack = ({
	appName,
	serverId,
	serviceId,
}: Props) => {
	const [option, setOption] = useState<"swarm" | "native">("native");
	const [containerId, setContainerId] = useState<string | undefined>();

	const { data: services, isPending: servicesLoading } =
		api.docker.getStackContainersByAppName.useQuery(
			{
				appName,
				serverId,
			},
			{
				enabled: !!appName && option === "swarm",
				refetchInterval: 5000,
			},
		);

	const { data, isPending: containersLoading } =
		api.docker.getContainersByAppNameMatch.useQuery(
			{
				appName,
				appType: "stack",
				serverId,
			},
			{
				enabled: !!appName && option === "native",
				refetchInterval: 5000,
			},
		);

	const containers = data?.filter((container) => container.containerId);
	const availableContainers = option === "native" ? containers : services;

	useEffect(() => {
		setContainerId((currentContainerId) =>
			resolveContainerSelection(currentContainerId, availableContainers),
		);
	}, [availableContainers]);

	const isLoading = option === "native" ? containersLoading : servicesLoading;

	const swarmError =
		option === "swarm"
			? services?.find((c) => c.containerId === containerId)?.error
			: undefined;

	return (
		<div className="flex flex-col gap-3">
			{swarmError && <AlertBlock type="error">{swarmError}</AlertBlock>}
			<DockerLogs
				serverId={serverId || ""}
				containerId={containerId || "select-a-container"}
				runType={option}
				serviceId={serviceId}
				toolbarStart={
					<ContainerPicker
						option={option}
						onOptionChange={(next) => {
							setContainerId(undefined);
							setOption(next);
						}}
						containerId={containerId}
						onContainerChange={setContainerId}
						isLoading={isLoading}
						containers={containers}
						services={services}
					/>
				}
			/>
		</div>
	);
};
