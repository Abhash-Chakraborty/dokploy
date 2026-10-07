import type * as React from "react";

import { cn } from "@/lib/utils";

// A card is a flat section of the page, not a box: nesting cards used to stack
// frames inside frames. Grids of selectable items ask for variant="tile".
function Card({
	className,
	size = "default",
	variant = "section",
	...props
}: React.ComponentProps<"div"> & {
	size?: "default" | "sm";
	variant?: "section" | "tile";
}) {
	return (
		<div
			data-slot="card"
			data-size={size}
			data-variant={variant}
			className={cn(
				"group/card flex flex-col text-sm text-card-foreground",
				// Consecutive sections are told apart by space and one hairline.
				variant === "section" &&
					"[[data-slot=card][data-variant=section]+&]:mt-8 [[data-slot=card][data-variant=section]+&]:border-t [[data-slot=card][data-variant=section]+&]:pt-8",
				variant === "tile" &&
					"rounded-lg bg-muted/60 transition-colors hover:bg-muted *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg",
				className,
			)}
			{...props}
		/>
	);
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-header"
			className={cn(
				"group/card-header @container/card-header grid auto-rows-min items-start gap-1 px-0 pt-0 pb-4 group-data-[variant=tile]/card:p-4 group-data-[variant=tile]/card:pb-2 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]",
				className,
			)}
			{...props}
		/>
	);
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-title"
			className={cn(
				"font-heading text-[15px] leading-snug font-semibold tracking-tight group-data-[size=sm]/card:text-sm",
				className,
			)}
			{...props}
		/>
	);
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-description"
			className={cn("text-sm text-muted-foreground", className)}
			{...props}
		/>
	);
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-action"
			className={cn(
				"col-start-2 row-span-2 row-start-1 self-start justify-self-end",
				className,
			)}
			{...props}
		/>
	);
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-content"
			className={cn("px-0 group-data-[variant=tile]/card:px-4 group-data-[variant=tile]/card:pb-4", className)}
			{...props}
		/>
	);
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
	return (
		<div
			data-slot="card-footer"
			className={cn("flex items-center gap-2 pt-4 group-data-[variant=tile]/card:px-4 group-data-[variant=tile]/card:pb-4", className)}
			{...props}
		/>
	);
}

export {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
};
