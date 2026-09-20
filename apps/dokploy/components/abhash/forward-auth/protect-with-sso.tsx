import { ShieldCheck } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { api } from "@/utils/api";

const isGate = (middleware: string) =>
	middleware.startsWith("abhash-fa-") && middleware.endsWith("@file");

/**
 * Puts the domain behind a forward-auth gate by managing the gate's entry in
 * the domain's middlewares. Hidden until a gate exists (Settings ->
 * Authentication).
 */
export const ProtectWithSso = ({
	value,
	onChange,
}: {
	value: string[];
	onChange: (middlewares: string[]) => void;
}) => {
	const { data: gates } = api.forwardAuth.options.useQuery();
	if (!gates?.length) return null;
	const current = value.find(isGate) ?? "none";

	return (
		<div className="flex flex-col gap-1.5">
			<Label className="flex items-center gap-1.5">
				<ShieldCheck className="size-4 text-muted-foreground" />
				Protect with SSO
			</Label>
			<Select
				value={current}
				onValueChange={(next) =>
					onChange([
						...value.filter((m) => !isGate(m)),
						...(next === "none" ? [] : [next]),
					])
				}
			>
				<SelectTrigger>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="none">Public (no sign-in)</SelectItem>
					{gates.map((g) => (
						<SelectItem key={g.middleware} value={g.middleware}>
							Require sign-in via {g.name}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
			<p className="text-xs text-muted-foreground">
				Visitors must sign in before reaching the app. Compose services apply
				this on their next deploy.
			</p>
		</div>
	);
};
