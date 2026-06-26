import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { api } from "@/utils/api";

type AuthMethods = {
	emailPassword: boolean;
	github: boolean;
	google: boolean;
	passkey: boolean;
};

const METHODS: {
	key: keyof AuthMethods;
	label: string;
	description: string;
}[] = [
	{
		key: "emailPassword",
		label: "Email & Password",
		description: "Sign in with email and password.",
	},
	{
		key: "github",
		label: "GitHub",
		description: "Sign in with a GitHub account.",
	},
	{
		key: "google",
		label: "Google",
		description: "Sign in with a Google account.",
	},
	{
		key: "passkey",
		label: "Passkey",
		description: "Sign in with a device passkey (WebAuthn).",
	},
];

/**
 * Per-method login toggles. The account owner can enable/disable email+pw,
 * GitHub, Google and passkey logins. At least one method must stay enabled
 * (enforced both here and server-side).
 */
export const LoginMethods = () => {
	const utils = api.useUtils();
	const { data, isLoading } = api.settings.getAuthMethods.useQuery();
	const { mutateAsync, isPending } =
		api.settings.updateAuthMethods.useMutation();
	const [methods, setMethods] = useState<AuthMethods | null>(null);

	useEffect(() => {
		if (data) setMethods(data as AuthMethods);
	}, [data]);

	const handleToggle = async (key: keyof AuthMethods, checked: boolean) => {
		if (!methods) return;
		const next = { ...methods, [key]: checked };
		if (!Object.values(next).some(Boolean)) {
			toast.error("At least one login method must remain enabled");
			return;
		}
		const prev = methods;
		setMethods(next);
		try {
			await mutateAsync({ authMethodsConfig: next });
			await utils.settings.getAuthMethods.invalidate();
			toast.success("Login methods updated");
		} catch (error) {
			setMethods(prev);
			toast.error(error instanceof Error ? error.message : "Failed to update");
		}
	};

	return (
		<Card className="bg-transparent">
			<CardHeader>
				<CardTitle className="text-xl">Login Methods</CardTitle>
				<CardDescription>
					Control which sign-in methods are available. At least one must stay
					enabled.
				</CardDescription>
			</CardHeader>
			<CardContent>
				{isLoading || !methods ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading…
					</div>
				) : (
					<div className="flex flex-col gap-4">
						{METHODS.map((m) => (
							<div
								key={m.key}
								className="flex items-center justify-between gap-4"
							>
								<div>
									<Label htmlFor={`auth-${m.key}`} className="text-primary">
										{m.label}
									</Label>
									<p className="text-xs text-muted-foreground">
										{m.description}
									</p>
								</div>
								<Switch
									id={`auth-${m.key}`}
									checked={methods[m.key]}
									disabled={isPending}
									onCheckedChange={(checked) => handleToggle(m.key, checked)}
								/>
							</div>
						))}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
