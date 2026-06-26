import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface PageContainerProps {
	children: ReactNode;
	className?: string;
}

/**
 * Edge-to-edge page wrapper. Replaces the boxed "canvas" look — content spans
 * the full width of the dashboard inset with a consistent vertical rhythm.
 */
export const PageContainer = ({ children, className }: PageContainerProps) => {
	return (
		<div className={cn("flex w-full flex-col gap-6", className)}>
			{children}
		</div>
	);
};

interface PageHeaderProps {
	title: ReactNode;
	description?: ReactNode;
	/** Action buttons rendered top-right, next to the heading. */
	actions?: ReactNode;
	icon?: ReactNode;
	className?: string;
}

/**
 * Standard page heading row: title (+ optional description/icon) on the left,
 * primary actions consolidated top-right. Used across dashboard pages so every
 * page's "Add / Create / Upload" button sits in the same place.
 */
export const PageHeader = ({
	title,
	description,
	actions,
	icon,
	className,
}: PageHeaderProps) => {
	return (
		<div
			className={cn(
				"flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between",
				className,
			)}
		>
			<div className="flex items-center gap-3 min-w-0">
				{icon && <span className="shrink-0 text-muted-foreground">{icon}</span>}
				<div className="min-w-0">
					<h1 className="text-xl font-semibold tracking-tight truncate">
						{title}
					</h1>
					{description && (
						<p className="text-sm text-muted-foreground">{description}</p>
					)}
				</div>
			</div>
			{actions && (
				<div className="flex shrink-0 items-center gap-2">{actions}</div>
			)}
		</div>
	);
};
