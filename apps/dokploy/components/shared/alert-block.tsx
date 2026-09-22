import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props extends React.ComponentPropsWithoutRef<"div"> {
	icon?: React.ReactNode;
	type?: "info" | "success" | "warning" | "error";
}

// Quiet by design: a hairline border and a tinted icon carry the tone, so a
// page with several notices does not turn into a wall of colour.
const iconMap = {
	info: {
		className: "border-border bg-muted/30 text-muted-foreground",
		iconClassName: "text-blue-500/80",
		icon: Info,
	},
	success: {
		className:
			"border-green-500/20 bg-green-500/5 text-green-700 dark:text-green-400",
		iconClassName: "text-green-500",
		icon: CheckCircle2,
	},
	warning: {
		className: "border-amber-500/20 bg-amber-500/5 text-muted-foreground",
		iconClassName: "text-amber-500",
		icon: AlertCircle,
	},
	error: {
		className: "border-red-500/25 bg-red-500/5 text-red-700 dark:text-red-400",
		iconClassName: "text-red-500",
		icon: AlertTriangle,
	},
};

export function AlertBlock({
	type = "info",
	icon,
	children,
	className,
	...props
}: Props) {
	const { className: toneClassName, iconClassName, icon: Icon } = iconMap[type];
	return (
		<div
			{...props}
			className={cn(
				"flex items-start flex-row gap-2.5 rounded-lg border px-3 py-2.5",
				toneClassName,
				className,
			)}
		>
			<div className={cn("shrink-0 mt-0.5", iconClassName)}>
				{icon || <Icon className="size-4" />}
			</div>
			<div className="flex-1 min-w-0">
				<span className="text-sm text-current wrap-break-word overflow-wrap-anywhere whitespace-pre-wrap">
					{children}
				</span>
			</div>
		</div>
	);
}
