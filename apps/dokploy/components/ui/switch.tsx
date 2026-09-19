import { Switch as SwitchPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "@/lib/utils";

// Geometry: the track has no border and a fixed padding, so the thumb's travel
// is exactly (track width - 2 * padding - thumb width). default: 36 - 4 - 16
// = 16px; sm: 24 - 2 - 12 = 10px. While pressed the thumb widens by 4px (2px
// for sm) and, when checked, shifts left by the same amount so it stays
// flush with the right edge.
function Switch({
	className,
	size = "default",
	...props
}: React.ComponentProps<typeof SwitchPrimitive.Root> & {
	size?: "sm" | "default";
}) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			data-size={size}
			className={cn(
				"peer group/switch relative inline-flex shrink-0 cursor-pointer items-center rounded-full outline-none transition-colors duration-200 ease-out after:absolute after:-inset-x-3 after:-inset-y-2",
				"data-[size=default]:h-5 data-[size=default]:w-9 data-[size=default]:p-0.5 data-[size=sm]:h-3.5 data-[size=sm]:w-6 data-[size=sm]:p-px",
				"data-checked:bg-primary hover:data-checked:bg-primary/90 data-unchecked:bg-muted-foreground/50 hover:data-unchecked:bg-muted-foreground/60 dark:data-unchecked:bg-input/80 dark:hover:data-unchecked:bg-input",
				"focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
				"aria-invalid:ring-2 aria-invalid:ring-destructive/40",
				"data-disabled:cursor-not-allowed data-disabled:opacity-50",
				"motion-reduce:transition-none",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className={cn(
					"pointer-events-none block rounded-full bg-background shadow-sm ring-0 transition-[translate,width] duration-200 ease-[cubic-bezier(0.34,1.4,0.64,1)] motion-reduce:transition-none",
					"dark:data-checked:bg-primary-foreground dark:data-unchecked:bg-foreground",
					"group-data-[size=default]/switch:h-4 group-data-[size=default]/switch:w-4 group-data-[size=default]/switch:data-checked:translate-x-4",
					"group-data-[size=default]/switch:group-active/switch:w-5 group-data-[size=default]/switch:group-active/switch:data-checked:translate-x-3",
					"group-data-[size=sm]/switch:h-3 group-data-[size=sm]/switch:w-3 group-data-[size=sm]/switch:data-checked:translate-x-2.5",
					"group-data-[size=sm]/switch:group-active/switch:w-3.5 group-data-[size=sm]/switch:group-active/switch:data-checked:translate-x-2",
					"data-unchecked:translate-x-0",
				)}
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
