import { ChevronDown } from "lucide-react";
import type React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Props = React.ComponentProps<typeof Button> & { label: string };

// PopoverTrigger asChild hands its props and ref down, so they are spread
// onto the Button rather than consumed here.
export const LogFilterTrigger = ({
	label,
	children,
	className,
	...props
}: Props) => (
	<Button
		variant="outline"
		size="xs"
		className={cn("h-8 gap-1.5 px-2.5 font-normal", className)}
		{...props}
	>
		<span className="text-muted-foreground">{label}</span>
		<span className="flex items-center gap-1 font-medium">{children}</span>
		<ChevronDown className="size-3 opacity-50" />
	</Button>
);
