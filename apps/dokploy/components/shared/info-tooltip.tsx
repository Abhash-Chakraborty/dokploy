import { AlertTriangle, Info, ShieldAlert } from "lucide-react";
import type { ReactNode } from "react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Variant = "info" | "warning" | "critical";

const VARIANT_CONFIG: Record<
	Variant,
	{ Icon: typeof Info; iconClass: string; contentClass: string }
> = {
	info: {
		Icon: Info,
		iconClass: "text-blue-500",
		contentClass: "border-blue-500/40",
	},
	warning: {
		Icon: AlertTriangle,
		iconClass: "text-amber-500",
		contentClass: "border-amber-500/40",
	},
	critical: {
		Icon: ShieldAlert,
		iconClass: "text-red-500",
		contentClass: "border-red-500/40",
	},
};

interface InfoTooltipProps {
	/** Tooltip body. Shown on hover/focus of the icon. */
	content: ReactNode;
	variant?: Variant;
	className?: string;
	size?: number;
	side?: "top" | "right" | "bottom" | "left";
}

/**
 * Color-coded icon + tooltip used to replace inline wall-of-text warnings and
 * to clarify settings. Variants: info (blue ℹ), warning (amber ⚠), critical
 * (red shield). Hovering the icon reveals the explanation.
 */
export const InfoTooltip = ({
	content,
	variant = "info",
	className,
	size = 14,
	side = "top",
}: InfoTooltipProps) => {
	const { Icon, iconClass, contentClass } = VARIANT_CONFIG[variant];
	return (
		<TooltipProvider>
			<Tooltip delayDuration={150}>
				<TooltipTrigger asChild>
					<button
						type="button"
						className={cn(
							"inline-flex items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring",
							className,
						)}
						aria-label="More information"
					>
						<Icon className={iconClass} style={{ width: size, height: size }} />
					</button>
				</TooltipTrigger>
				<TooltipContent
					side={side}
					className={cn("max-w-xs text-sm", contentClass)}
				>
					{content}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	);
};
