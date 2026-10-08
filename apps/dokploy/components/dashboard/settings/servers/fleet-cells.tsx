import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Megabytes to the largest sensible unit — 5927 reads better as 5.8 GB. */
export const formatMb = (mb: number) =>
	mb >= 1024 * 1024
		? `${(mb / 1024 / 1024).toFixed(1)} TB`
		: mb >= 1024
			? `${(mb / 1024).toFixed(1)} GB`
			: `${Math.round(mb)} MB`;

/** Headroom colouring: green under 70%, amber to 90%, red beyond. */
const usageTone = (percent?: number) => {
	if (percent === undefined) return "text-muted-foreground";
	if (percent >= 90) return "text-red-500";
	if (percent >= 70) return "text-amber-500";
	return "text-emerald-500";
};

export const Usage = ({ percent }: { percent?: number }) =>
	percent === undefined ? (
		<span className="text-muted-foreground">—</span>
	) : (
		<span className={cn("tabular-nums font-medium", usageTone(percent))}>
			{Math.round(percent)}%
		</span>
	);

/**
 * A warning that says what is wrong and goes to the page that fixes it.
 * Command centre is where patching and baselines are actually run from.
 */
export const DriftWarning = ({
	what,
	versions,
}: {
	what: string;
	versions: string[];
}) => (
	<Tooltip>
		<TooltipTrigger asChild>
			<Link
				href="/dashboard/command-center"
				aria-label={`${what} versions differ across the fleet; open Command centre`}
				onClick={(event) => event.stopPropagation()}
			>
				<TriangleAlert className="size-3.5 text-amber-500 transition-colors hover:text-amber-400" />
			</Link>
		</TooltipTrigger>
		<TooltipContent>
			<p>Fleet runs {versions.join(", ")}</p>
			<p className="text-muted-foreground">Patch from Command centre</p>
		</TooltipContent>
	</Tooltip>
);
