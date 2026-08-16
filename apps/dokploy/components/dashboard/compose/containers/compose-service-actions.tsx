import { Minus, Plus, RotateCcw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

interface Props {
	composeId: string;
	onChanged?: () => void;
}

/**
 * Acts on one service rather than the whole stack.
 *
 * Redeploying a stack to restart a single wedged container is the common
 * frustration this removes — everything else stays exactly as it is.
 */
export const ComposeServiceActions = ({ composeId, onChanged }: Props) => {
	const [service, setService] = useState("");
	const [replicas, setReplicas] = useState(1);

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
		<div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
			<div className="flex min-w-[220px] flex-col gap-1.5">
				<span className="text-xs font-medium text-muted-foreground">
					Service
				</span>
				<Select value={service} onValueChange={setService}>
					<SelectTrigger>
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
			</div>

			<Button
				variant="outline"
				disabled={!service}
				isLoading={restart.isPending}
				onClick={() =>
					act(
						() => restart.mutateAsync({ composeId, serviceName: service }),
						`Restarted ${service}`,
						"Could not restart the service",
					)
				}
			>
				<RotateCcw className="size-4" />
				Restart
			</Button>

			<div className="flex flex-col gap-1.5">
				<span className="text-xs font-medium text-muted-foreground">
					Replicas
				</span>
				<div className="flex items-center gap-1">
					<Button
						variant="outline"
						size="icon"
						aria-label="Fewer replicas"
						onClick={() => setReplicas((n) => Math.max(0, n - 1))}
					>
						<Minus className="size-4" />
					</Button>
					<Input
						className="w-16 text-center tabular-nums"
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
						size="icon"
						aria-label="More replicas"
						onClick={() => setReplicas((n) => Math.min(100, n + 1))}
					>
						<Plus className="size-4" />
					</Button>
				</div>
			</div>

			<Button
				variant="outline"
				disabled={!service}
				isLoading={scale.isPending}
				onClick={() =>
					act(
						() =>
							scale.mutateAsync({ composeId, serviceName: service, replicas }),
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
