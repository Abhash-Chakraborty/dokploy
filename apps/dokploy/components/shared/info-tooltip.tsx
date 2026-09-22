import { Info, TriangleAlert } from "lucide-react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Variant = "info" | "warning" | "critical";

// One convention across the app: a circle-i is information, a triangle is a
// warning. Anything that must be seen without hovering belongs in an
// AlertBlock instead.
const VARIANTS: Record<Variant, { Icon: typeof Info; className: string }> = {
	info: {
		Icon: Info,
		className: "text-muted-foreground/70 hover:text-foreground",
	},
	warning: {
		Icon: TriangleAlert,
		className: "text-amber-500/80 hover:text-amber-500",
	},
	critical: {
		Icon: TriangleAlert,
		className: "text-red-500/80 hover:text-red-500",
	},
};

interface InfoTooltipProps {
	content: ReactNode;
	variant?: Variant;
	className?: string;
	size?: number;
	side?: "top" | "right" | "bottom" | "left";
	label?: string;
}

export const InfoTooltip = ({
	content,
	variant = "info",
	className,
	size = 14,
	side = "top",
	label = "More information",
}: InfoTooltipProps) => {
	const { Icon } = VARIANTS[variant];
	return (
		<TooltipPrimitive.Provider delayDuration={100}>
			<TooltipPrimitive.Root>
				<TooltipPrimitive.Trigger asChild>
					<button
						type="button"
						aria-label={label}
						className={cn(
							"inline-flex shrink-0 items-center justify-center rounded-full align-middle transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
							VARIANTS[variant].className,
							className,
						)}
						// A hint inside a clickable card or a form label must not
						// trigger the card's link or focus the input.
						onClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
						}}
					>
						<Icon style={{ width: size, height: size }} />
					</button>
				</TooltipPrimitive.Trigger>
				<TooltipPrimitive.Portal>
					<TooltipPrimitive.Content
						side={side}
						sideOffset={6}
						collisionPadding={12}
						className="z-50 max-w-sm rounded-lg border bg-popover px-3 py-2 text-xs leading-relaxed font-normal text-popover-foreground shadow-md data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-closed:animate-out data-closed:fade-out-0 [&_a]:underline [&_a]:underline-offset-2 [&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[11px]"
					>
						{content}
					</TooltipPrimitive.Content>
				</TooltipPrimitive.Portal>
			</TooltipPrimitive.Root>
		</TooltipPrimitive.Provider>
	);
};
