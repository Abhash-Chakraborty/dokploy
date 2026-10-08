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
	className,
}: PageHeaderProps) => {
	return (
		<div
			className={cn(
				"flex flex-col gap-3 pt-4 pb-2 sm:flex-row sm:items-end sm:justify-between",
				className,
			)}
		>
			<div className="min-w-0">
				{title ? (
					<h1 className="truncate text-[22px] font-semibold leading-tight tracking-tight">
						{title}
					</h1>
				) : null}
				{description && (
					<p className="mt-1 text-sm text-muted-foreground">{description}</p>
				)}
			</div>
			{actions && (
				<div className="flex shrink-0 items-center gap-2">{actions}</div>
			)}
		</div>
	);
};

interface SectionHeaderProps {
	title: ReactNode;
	description?: ReactNode;
	actions?: ReactNode;
	className?: string;
}

/** Heading for a section inside a page: smaller than PageHeader, no icon. */
export const SectionHeader = ({
	title,
	description,
	actions,
	className,
}: SectionHeaderProps) => (
	<div
		className={cn(
			"flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between",
			className,
		)}
	>
		<div className="min-w-0">
			<h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
			{description && (
				<p className="text-[13px] text-muted-foreground">{description}</p>
			)}
		</div>
		{actions && (
			<div className="flex shrink-0 items-center gap-2">{actions}</div>
		)}
	</div>
);
