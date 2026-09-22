import { Minus, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { InfoTooltip } from "@/components/shared/info-tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
	appType?: "stack" | "docker-compose";
	onChanged?: () => void;
}

/**
 * Acts on one service rather than the whole stack.
 *
 * Redeploying a stack to restart a single wedged container is the common
 * frustration this removes — everything else stays exactly as it is.
 */
export const ComposeServiceActions = ({
	composeId,
	appType = "docker-compose",
	onChanged,
}: Props) => {
	const [service, setService] = useState("");
	const [replicas, setReplicas] = useState(1);
	const [spread, setSpread] = useState(false);
	const [maxPerNode, setMaxPerNode] = useState(0);
	const isStack = appType === "stack";

	const { data: services = [] } = api.compose.loadServices.useQuery(
		{ composeId, type: "fetch" },
		{ enabled: !!composeId },
	);

	const restart = api.compose.restartService.useMutation();
	const scale = api.compose.scaleService.useMutation();

	const act = async (
		fn: () => Promise<unknown>,
		success: string,
		failure: string,
	) => {
		try {
			await fn();
			toast.success(success);
			onChanged?.();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : failure);
		}
	};

	return (
		<div className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2">
			<Select value={service} onValueChange={setService}>
				<SelectTrigger size="sm" className="w-56" aria-label="Service">
					<SelectValue placeholder="Pick a service" />
				</SelectTrigger>
				<SelectContent>
					{services.map((name) => (
						<SelectItem key={name} value={name}>
							{name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>

			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							variant="outline"
							size="icon-sm"
							aria-label="Restart"
							disabled={!service}
							isLoading={restart.isPending}
							onClick={() =>
								act(
									() =>
										restart.mutateAsync({ composeId, serviceName: service }),
									`Restarted ${service}`,
									"Could not restart the service",
								)
							}
						>
							{!restart.isPending && <RotateCcw className="size-4" />}
						</Button>
					</TooltipTrigger>
					<TooltipContent>Restart</TooltipContent>
				</Tooltip>
			</TooltipProvider>

			<div className="mx-1 h-6 w-px bg-border" />

			<span className="text-sm text-muted-foreground">Replicas</span>
			<div className="flex items-center">
				<Button
					variant="outline"
					size="icon-sm"
					className="rounded-r-none"
					aria-label="Fewer replicas"
					onClick={() => setReplicas((n) => Math.max(0, n - 1))}
				>
					<Minus className="size-3.5" />
				</Button>
				<Input
					aria-label="Replicas"
					className="h-9 w-14 rounded-none border-x-0 text-center tabular-nums"
					value={replicas}
					inputMode="numeric"
					onChange={(event) => {
						const next = Number.parseInt(event.target.value, 10);
						setReplicas(
							Number.isFinite(next) ? Math.min(100, Math.max(0, next)) : 0,
						);
					}}
				/>
				<Button
					variant="outline"
					size="icon-sm"
					className="rounded-l-none"
					aria-label="More replicas"
					onClick={() => setReplicas((n) => Math.min(100, n + 1))}
				>
					<Plus className="size-3.5" />
				</Button>
			</div>

			{isStack && (
				<>
					<div className="flex items-center gap-2 pl-1">
						<Switch
							id={`spread-${composeId}`}
							checked={spread}
							onCheckedChange={setSpread}
						/>
						<label
							htmlFor={`spread-${composeId}`}
							className="text-sm text-muted-foreground"
						>
							Spread across nodes
						</label>
					</div>
					{spread && (
						<Input
							aria-label="Max replicas per node"
							type="number"
							min={0}
							placeholder="Max/node"
							className="h-9 w-24"
							value={maxPerNode || ""}
							onChange={(event) =>
								setMaxPerNode(
									Math.max(0, Number.parseInt(event.target.value, 10) || 0),
								)
							}
						/>
					)}
					<InfoTooltip
						content={
							<span>
								Spreads the service evenly over the nodes of this server's
								swarm, and caps how many land on one node. It lasts until the
								next deploy; to keep it, set{" "}
								<code>deploy.placement.preferences: [spread: node.id]</code> and{" "}
								<code>max_replicas_per_node</code> in the compose file.
							</span>
						}
					/>
				</>
			)}

			<Button
				size="sm"
				className="ml-auto"
				disabled={!service}
				isLoading={scale.isPending}
				onClick={() =>
					act(
						() =>
							scale.mutateAsync({
								composeId,
								serviceName: service,
								replicas,
								...(isStack ? { spread: { spread, maxPerNode } } : {}),
							}),
						`Scaled ${service} to ${replicas}`,
						"Could not scale the service",
					)
				}
			>
				Scale
			</Button>
		</div>
	);
};
