import { Loader2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { resolveContainerSelection } from "@/components/dashboard/docker/logs/utils";
import { AlertBlock } from "@/components/shared/alert-block";
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
import { cn } from "@/lib/utils";
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

export const badgeStateColor = (state: string) => {
	switch (state) {
		case "running":
		case "ready":
			return "green";
		case "exited":
		case "shutdown":
			return "red";
		case "accepted":
		case "created":
			return "blue";
		default:
			return "default";
	}
};

interface Props {
	appName: string;
	serverId?: string;
	serviceId?: string;
}

export const ShowDockerLogs = ({ appName, serverId, serviceId }: Props) => {
	const [containerId, setContainerId] = useState<string | undefined>();
	const [option, setOption] = useState<"swarm" | "native">("native");

	const { data: services, isPending: servicesLoading } =
		api.docker.getServiceContainersByAppName.useQuery(
			{
				appName,
				serverId,
			},
			{
				enabled: !!appName && option === "swarm",
			},
		);

	const { data: containers, isPending: containersLoading } =
		api.docker.getContainersByAppNameMatch.useQuery(
			{
				appName,
				serverId,
			},
			{
				enabled: !!appName && option === "native",
			},
		);

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

	const picker = (
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
	);

	return (
		<div className="flex flex-col gap-3">
			{swarmError && <AlertBlock type="error">{swarmError}</AlertBlock>}
			<DockerLogs
				serverId={serverId || ""}
				containerId={containerId || "select-a-container"}
				runType={option}
				serviceId={serviceId}
				toolbarStart={picker}
			/>
		</div>
	);
};

export const ContainerModeToggle = ({
	value,
	onChange,
}: {
	value: "swarm" | "native";
	onChange: (value: "swarm" | "native") => void;
}) => (
	<fieldset
		aria-label="Container source"
		className="m-0 flex h-8 min-w-0 items-center rounded-lg border p-0.5 text-xs"
	>
		{(["native", "swarm"] as const).map((mode) => (
			<button
				key={mode}
				type="button"
				aria-pressed={value === mode}
				onClick={() => value !== mode && onChange(mode)}
				className={cn(
					"h-full rounded-md px-2.5 capitalize transition-colors",
					value === mode
						? "bg-muted text-foreground"
						: "text-muted-foreground hover:text-foreground",
				)}
			>
				{mode}
			</button>
		))}
	</fieldset>
);

type NativeContainer = {
	containerId: string;
	name: string;
	state: string;
	status?: string | null;
};
type SwarmTask = NativeContainer & {
	node?: string | null;
	currentState?: string | null;
};

export const ContainerPicker = ({
	option,
	onOptionChange,
	containerId,
	onContainerChange,
	isLoading,
	containers,
	services,
}: {
	option: "swarm" | "native";
	onOptionChange: (value: "swarm" | "native") => void;
	containerId?: string;
	onContainerChange: (value: string) => void;
	isLoading: boolean;
	containers?: NativeContainer[];
	services?: SwarmTask[];
}) => {
	const count = option === "native" ? containers?.length : services?.length;
	return (
		<>
			<ContainerModeToggle value={option} onChange={onOptionChange} />
			<Select onValueChange={onContainerChange} value={containerId}>
				<SelectTrigger
					size="sm"
					className="h-8 w-full min-w-0 text-xs sm:w-72 [&>span]:truncate"
					aria-label="Container"
				>
					{isLoading ? (
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
						<SelectLabel>Containers ({count ?? 0})</SelectLabel>
						{option === "native"
							? containers?.map((container) => (
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
								))
							: services?.map((container) => (
									<SelectItem
										key={container.containerId}
										value={container.containerId}
									>
										{container.name} ({container.containerId}@{container.node})
										<Badge variant={badgeStateColor(container.state)}>
											{container.state}
										</Badge>
										{container.currentState ? ` ${container.currentState}` : ""}
									</SelectItem>
								))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</>
	);
};
