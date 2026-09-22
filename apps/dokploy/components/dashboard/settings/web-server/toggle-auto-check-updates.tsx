import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

export const ToggleAutoCheckUpdates = ({ disabled }: { disabled: boolean }) => {
	const [enabled, setEnabled] = useState<boolean>(
		localStorage.getItem("enableAutoCheckUpdates") === "true",
	);

	const handleToggle = (checked: boolean) => {
		setEnabled(checked);
		localStorage.setItem("enableAutoCheckUpdates", String(checked));
	};

	return (
		<div className="flex items-center gap-2">
			<Switch
				checked={enabled}
				onCheckedChange={handleToggle}
				id="autoCheckUpdatesToggle"
				disabled={disabled}
			/>
			<Label
				className="text-xs font-normal text-muted-foreground"
				htmlFor="autoCheckUpdatesToggle"
			>
				Check automatically
			</Label>
		</div>
	);
};
