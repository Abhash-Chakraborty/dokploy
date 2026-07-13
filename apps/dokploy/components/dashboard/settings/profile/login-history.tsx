import { Globe, Loader2, LogOut, Monitor, Smartphone } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

type DeviceSession = {
	createdAt: Date | string;
	expiresAt: Date | string;
	id: string;
	ipAddress?: string | null;
	token: string;
	userAgent?: string | null;
};

const formatDate = (date: Date | string | null | undefined) =>
	date ? new Date(date).toLocaleString() : "Unknown";

const describeDevice = (userAgent?: string | null) => {
	if (!userAgent) return { browser: "Unknown browser", mobile: false };
	const browser = userAgent.includes("Edg/")
		? "Microsoft Edge"
		: userAgent.includes("Firefox/")
			? "Firefox"
			: userAgent.includes("Chrome/")
				? "Chrome"
				: userAgent.includes("Safari/")
					? "Safari"
					: "Browser";
	const mobile = /Android|iPhone|iPad|Mobile/i.test(userAgent);
	const platform = userAgent.includes("Windows")
		? "Windows"
		: userAgent.includes("Android")
			? "Android"
			: /iPhone|iPad/.test(userAgent)
				? "iOS"
				: userAgent.includes("Mac OS")
					? "macOS"
					: userAgent.includes("Linux")
						? "Linux"
						: "Unknown OS";
	return { browser: `${browser} on ${platform}`, mobile };
};

/** Active Better Auth sessions with device-level revocation controls. */
export const LoginHistory = () => {
	const [sessions, setSessions] = useState<DeviceSession[]>([]);
	const [currentToken, setCurrentToken] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [revokingToken, setRevokingToken] = useState<string | null>(null);
	const [isRevokingOthers, setIsRevokingOthers] = useState(false);

	const loadSessions = useCallback(async () => {
		setIsLoading(true);
		try {
			const [sessionResult, sessionsResult] = await Promise.all([
				authClient.getSession({ fetchOptions: { cache: "no-store" } }),
				authClient.listSessions(),
			]);
			if (sessionsResult.error) throw sessionsResult.error;
			setCurrentToken(sessionResult.data?.session.token ?? null);
			setSessions((sessionsResult.data as DeviceSession[] | null) ?? []);
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to load active devices",
			);
		} finally {
			setIsLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadSessions();
	}, [loadSessions]);

	const revokeSession = async (token: string) => {
		setRevokingToken(token);
		try {
			const result = await authClient.revokeSession({ token });
			if (result.error) throw result.error;
			setSessions((current) =>
				current.filter((session) => session.token !== token),
			);
			toast.success("Device signed out");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to revoke this session",
			);
		} finally {
			setRevokingToken(null);
		}
	};

	const revokeOtherSessions = async () => {
		setIsRevokingOthers(true);
		try {
			const result = await authClient.revokeOtherSessions();
			if (result.error) throw result.error;
			setSessions((current) =>
				current.filter((session) => session.token === currentToken),
			);
			toast.success("Other devices signed out");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Unable to revoke other sessions",
			);
		} finally {
			setIsRevokingOthers(false);
		}
	};

	const otherSessionCount = sessions.filter(
		(session) => session.token !== currentToken,
	).length;

	return (
		<Card className="bg-transparent">
			<CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
				<div>
					<CardTitle className="flex items-center gap-2 text-xl">
						<Globe className="size-5 text-muted-foreground" />
						Devices
					</CardTitle>
					<CardDescription>
						Browsers currently signed in to your account.
					</CardDescription>
				</div>
				<Button
					variant="outline"
					size="sm"
					disabled={otherSessionCount === 0}
					isLoading={isRevokingOthers}
					onClick={revokeOtherSessions}
				>
					<LogOut className="size-4" />
					Sign out other devices
				</Button>
			</CardHeader>
			<CardContent>
				{isLoading ? (
					<div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
						<Loader2 className="size-4 animate-spin" /> Loading devices…
					</div>
				) : sessions.length === 0 ? (
					<p className="py-4 text-sm text-muted-foreground">
						No active sessions found.
					</p>
				) : (
					<div className="divide-y rounded-lg border">
						{sessions.map((session) => {
							const device = describeDevice(session.userAgent);
							const isCurrent = session.token === currentToken;
							const DeviceIcon = device.mobile ? Smartphone : Monitor;
							return (
								<div
									key={session.id}
									className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
								>
									<div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40">
										<DeviceIcon className="size-4 text-muted-foreground" />
									</div>
									<div className="min-w-0 flex-1">
										<div className="flex flex-wrap items-center gap-2">
											<p className="font-medium">{device.browser}</p>
											{isCurrent && (
												<Badge variant="secondary">This device</Badge>
											)}
										</div>
										<p className="mt-1 text-xs text-muted-foreground">
											{session.ipAddress || "Unknown IP"} · Signed in{" "}
											{formatDate(session.createdAt)}
										</p>
									</div>
									<Button
										variant="ghost"
										size="sm"
										disabled={isCurrent}
										isLoading={revokingToken === session.token}
										onClick={() => revokeSession(session.token)}
									>
										Revoke
									</Button>
								</div>
							);
						})}
					</div>
				)}
			</CardContent>
		</Card>
	);
};
