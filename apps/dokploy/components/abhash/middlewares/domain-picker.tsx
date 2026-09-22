import Link from "next/link";
import { InfoTooltip } from "@/components/shared/info-tooltip";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";
import { KINDS } from "./middlewares-page";

/**
 * Picks a middleware defined under Settings → Middlewares for one domain.
 * Middlewares scoped to every project or to chosen projects are attached
 * without being picked, so they are only listed here for reference.
 */
export const MiddlewarePicker = ({
	value,
	onChange,
}: {
	value: string[];
	onChange: (next: string[]) => void;
}) => {
	const { data: options } = api.middlewares.options.useQuery();
	if (!options) return null;
	const pickable = options.filter(
		(option) => option.scope === "manual" && !value.includes(option.ref),
	);
	const automatic = options.filter((option) => option.scope !== "manual");

	return (
		<div className="flex items-center gap-2">
			<Select
				value=""
				disabled={pickable.length === 0}
				onValueChange={(ref) => onChange([...value, ref])}
			>
				<SelectTrigger className="h-9">
					<SelectValue
						placeholder={
							options.length === 0
								? "No saved middlewares yet"
								: pickable.length === 0
									? "All saved middlewares added"
									: "Add a saved middleware"
						}
					/>
				</SelectTrigger>
				<SelectContent>
					{pickable.map((option) => (
						<SelectItem key={option.ref} value={option.ref}>
							{option.name}
							<span className="ml-2 text-xs text-muted-foreground">
								{KINDS[option.kind]?.label ?? option.kind}
							</span>
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<InfoTooltip
				content={
					<span>
						Saved middlewares live under{" "}
						<Link href="/dashboard/settings/middlewares" className="underline">
							Settings → Middlewares
						</Link>
						.
						{automatic.length > 0 &&
							` Applied to their projects without picking: ${automatic
								.map((option) => option.name)
								.join(", ")}.`}
					</span>
				}
			/>
		</div>
	);
};
