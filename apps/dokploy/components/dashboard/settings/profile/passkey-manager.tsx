import { Fingerprint, Loader2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { DialogAction } from "@/components/shared/dialog-action";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

type Passkey = {
	id: string;
	name?: string | null;
	createdAt?: Date | string | null;
	deviceType?: string | null;
};

const getPasskeyErrorMessage = (error: unknown, fallback: string) => {
	if (error instanceof Error && error.message) return error.message;
	if (
		error &&
		typeof error === "object" &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message;
	}
	return fallback;
};

/**
 * Register / list / remove WebAuthn passkeys for the current user via the
 * Better Auth passkey plugin.
 */
export const PasskeyManager = () => {
	const [passkeys, setPasskeys] = useState<Passkey[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isAdding, setIsAdding] = useState(false);

	const load = async () => {
		try {
			const { data, error } = await authClient.passkey.listUserPasskeys();
			if (error) throw error;
			setPasskeys((data as Passkey[]) ?? []);
		} catch {
			// Listing can fail if the browser has no WebAuthn support; show empty.
			setPasskeys([]);
		} finally {
			setIsLoading(false);
		}
	};

	useEffect(() => {
		load();
	}, []);

	const handleAdd = async () => {
		if (!window.isSecureContext) {
			toast.error("Passkeys require HTTPS or localhost");
			return;
		}
		if (!("PublicKeyCredential" in window)) {
			toast.error("This browser or device does not support passkeys");
			return;
		}
		setIsAdding(true);
		try {
			const platform =
				(
					navigator as Navigator & {
						userAgentData?: { platform?: string };
					}
				).userAgentData?.platform || navigator.platform;
			const result = await authClient.passkey.addPasskey({
				name: platform || "Device",
			});
			if (result?.error) {
				throw result.error;
			}
			toast.success("Passkey registered");
			await load();
		} catch (error) {
			toast.error(getPasskeyErrorMessage(error, "Failed to register passkey"));
		} finally {
			setIsAdding(false);
		}
	};

	const handleDelete = async (id: string) => {
		try {
			const { error } = await authClient.passkey.deletePasskey({ id });
			if (error) throw error;
			toast.success("Passkey removed");
			await load();
		} catch (error) {
			toast.error(getPasskeyErrorMessage(error, "Failed to remove passkey"));
		}
	};

	return (
		<Card className="bg-transparent">
			<CardHeader className="flex flex-row items-center justify-between">
				<div>
					<CardTitle className="text-xl flex items-center gap-2">
						<Fingerprint className="size-5 text-muted-foreground" />
						Passkeys
					</CardTitle>
					<CardDescription>
						Sign in without a password using device biometrics or security keys.
					</CardDescription>
				</div>
				<Button onClick={handleAdd} isLoading={isAdding} variant="secondary">
					<Fingerprint className="size-4" />
					Add Passkey
				</Button>
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<div className="flex items-center gap-2 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading…
					</div>
				) : passkeys.length === 0 ? (
					<p className="text-sm text-muted-foreground">
						No passkeys registered yet.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{passkeys.map((pk) => (
							<li
								key={pk.id}
								className="flex items-center justify-between rounded-md border px-3 py-2"
							>
								<div className="flex items-center gap-2 min-w-0">
									<Fingerprint className="size-4 shrink-0 text-muted-foreground" />
									<span className="truncate text-sm">
										{pk.name || "Passkey"}
									</span>
									{pk.createdAt && (
										<span className="text-xs text-muted-foreground">
											· {new Date(pk.createdAt).toLocaleDateString()}
										</span>
									)}
								</div>
								<DialogAction
									title="Remove passkey?"
									description="This passkey will no longer be usable to sign in."
									onClick={() => handleDelete(pk.id)}
								>
									<Button variant="ghost" size="icon">
										<Trash2 className="size-4 text-destructive" />
									</Button>
								</DialogAction>
							</li>
						))}
					</ul>
				)}
			</CardContent>
		</Card>
	);
};
