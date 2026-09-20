import { KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth-client";
import { api } from "@/utils/api";

const DEFAULT_CONFIG = { providers: [], enforced: false, allowPasskey: true };

export const useSsoLoginConfig = () => {
	const { data } = api.abhashSso.publicConfig.useQuery(undefined, {
		refetchOnWindowFocus: false,
	});
	return data ?? DEFAULT_CONFIG;
};

const start = async (
	params: { providerId: string } | { email: string },
	onError: (message: string) => void,
) => {
	const { error } = await authClient.signIn.sso({
		...params,
		callbackURL: "/dashboard/home",
		errorCallbackURL: "/",
	});
	if (error) onError(error.message ?? "Could not start single sign-on");
};

/** Provider buttons and domain-based SSO for the sign-in page. */
export const SsoLogin = () => {
	const { providers } = useSsoLoginConfig();
	const [pending, setPending] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [showEmail, setShowEmail] = useState(false);
	if (providers.length === 0) return null;

	const fail = (message: string) => {
		toast.error(message);
		setPending(null);
	};

	return (
		<div className="flex flex-col gap-2">
			{providers.map((p) => (
				<Button
					key={p.providerId}
					type="button"
					variant="outline"
					className="w-full"
					isLoading={pending === p.providerId}
					onClick={async () => {
						setPending(p.providerId);
						await start({ providerId: p.providerId }, fail);
					}}
				>
					{pending !== p.providerId && <ShieldCheck className="size-4" />}
					Continue with {p.displayName}
				</Button>
			))}
			{showEmail ? (
				<form
					className="flex gap-2"
					onSubmit={async (e) => {
						e.preventDefault();
						setPending("email");
						await start({ email }, fail);
					}}
				>
					<Input
						type="email"
						required
						autoFocus
						placeholder="you@company.com"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
					/>
					<Button type="submit" isLoading={pending === "email"}>
						Continue
					</Button>
				</form>
			) : (
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="text-muted-foreground"
					onClick={() => setShowEmail(true)}
				>
					<KeyRound className="size-4" />
					Sign in with your work email
				</Button>
			)}
		</div>
	);
};

/**
 * With SSO enforced, the password form is only for an owner locking
 * themselves back in, so it sits behind a disclosure.
 */
export const EmergencySignIn = ({
	enforced,
	children,
}: {
	enforced: boolean;
	children: React.ReactNode;
}) => {
	const [open, setOpen] = useState(false);
	if (!enforced) return <>{children}</>;
	return open ? (
		<div className="flex flex-col gap-3 rounded-md border border-dashed p-3">
			<p className="text-xs text-muted-foreground">
				Single sign-on is required. Only an organization owner can sign in with
				a password here, and it is recorded in the audit log.
			</p>
			{children}
		</div>
	) : (
		<Button
			type="button"
			variant="link"
			size="sm"
			className="text-muted-foreground"
			onClick={() => setOpen(true)}
		>
			Owner emergency sign-in
		</Button>
	);
};
