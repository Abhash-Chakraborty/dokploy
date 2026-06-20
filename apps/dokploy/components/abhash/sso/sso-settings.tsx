import { Globe2, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
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
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/utils/api";

type ProviderType = "oidc" | "saml";

const blankForm = {
	providerId: "",
	domain: "",
	issuer: "",
	clientId: "",
	clientSecret: "",
	discoveryEndpoint: "",
	scopes: "openid email profile",
	entryPoint: "",
	cert: "",
	callbackUrl: "",
	audience: "",
};

const splitScopes = (value: string) =>
	value
		.split(/[,\s]+/)
		.map((scope) => scope.trim())
		.filter(Boolean);

const currentOrigin = () => {
	if (typeof window === "undefined") return "";
	return window.location.origin;
};

export function AbhashSSOSettings() {
	const utils = api.useUtils();
	const { data: providers = [], isLoading } = api.sso.listProviders.useQuery();
	const { data: trustedOrigins = [] } = api.sso.getTrustedOrigins.useQuery();
	const register = api.sso.register.useMutation();
	const update = api.sso.update.useMutation();
	const deleteProvider = api.sso.deleteProvider.useMutation();
	const addTrustedOrigin = api.sso.addTrustedOrigin.useMutation();
	const removeTrustedOrigin = api.sso.removeTrustedOrigin.useMutation();
	const [providerType, setProviderType] = useState<ProviderType>("oidc");
	const [form, setForm] = useState(blankForm);
	const [trustedOrigin, setTrustedOrigin] = useState("");

	const callbackUrl = useMemo(() => {
		if (form.callbackUrl) return form.callbackUrl;
		if (!form.providerId) return `${currentOrigin()}/api/auth/sso/callback/:id`;
		return `${currentOrigin()}/api/auth/sso/callback/${form.providerId}`;
	}, [form.callbackUrl, form.providerId]);

	const existingProvider = providers.find(
		(provider) => provider.providerId === form.providerId,
	);

	const setField = (key: keyof typeof blankForm, value: string) => {
		setForm((current) => ({ ...current, [key]: value }));
	};

	const refresh = async () => {
		await Promise.all([
			utils.sso.listProviders.invalidate(),
			utils.sso.showSignInWithSSO.invalidate(),
			utils.sso.getTrustedOrigins.invalidate(),
		]);
	};

	const editProvider = (provider: (typeof providers)[number]) => {
		let oidcConfig: Record<string, unknown> = {};
		let samlConfig: Record<string, unknown> = {};
		try {
			oidcConfig =
				typeof provider.oidcConfig === "string"
					? JSON.parse(provider.oidcConfig)
					: (provider.oidcConfig ?? {});
		} catch {
			oidcConfig = {};
		}
		try {
			samlConfig =
				typeof provider.samlConfig === "string"
					? JSON.parse(provider.samlConfig)
					: (provider.samlConfig ?? {});
		} catch {
			samlConfig = {};
		}

		const nextType = provider.samlConfig ? "saml" : "oidc";
		setProviderType(nextType);
		setForm({
			providerId: provider.providerId,
			domain: provider.domain.split(",")[0] ?? "",
			issuer: provider.issuer,
			clientId: String(oidcConfig.clientId ?? ""),
			clientSecret: "",
			discoveryEndpoint: String(oidcConfig.discoveryEndpoint ?? ""),
			scopes: Array.isArray(oidcConfig.scopes)
				? oidcConfig.scopes.join(" ")
				: "openid email profile",
			entryPoint: String(samlConfig.entryPoint ?? ""),
			cert: String(samlConfig.cert ?? ""),
			callbackUrl: String(samlConfig.callbackUrl ?? ""),
			audience: String(samlConfig.audience ?? ""),
		});
	};

	const saveProvider = async () => {
		if (!form.providerId || !form.domain || !form.issuer) {
			toast.error("Provider ID, domain, and issuer are required");
			return;
		}

		const body =
			providerType === "oidc"
				? {
						providerId: form.providerId.trim(),
						issuer: form.issuer.trim(),
						domains: [form.domain.trim().toLowerCase()],
						oidcConfig: {
							clientId: form.clientId.trim(),
							clientSecret: form.clientSecret,
							discoveryEndpoint: form.discoveryEndpoint.trim() || undefined,
							scopes: splitScopes(form.scopes),
							pkce: true,
						},
					}
				: {
						providerId: form.providerId.trim(),
						issuer: form.issuer.trim(),
						domains: [form.domain.trim().toLowerCase()],
						samlConfig: {
							entryPoint: form.entryPoint.trim(),
							cert: form.cert.trim(),
							callbackUrl,
							audience: form.audience.trim() || undefined,
							spMetadata: {
								entityID: callbackUrl,
								binding: "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
							},
						},
					};

		try {
			if (existingProvider) {
				await update.mutateAsync(body);
				toast.success("SSO provider updated");
			} else {
				await register.mutateAsync(body);
				toast.success("SSO provider created");
			}
			setForm(blankForm);
			await refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to save SSO provider",
			);
		}
	};

	const onDelete = async (providerId: string) => {
		try {
			await deleteProvider.mutateAsync({ providerId });
			await refresh();
			toast.success("SSO provider deleted");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: "Failed to delete SSO provider",
			);
		}
	};

	const onAddTrustedOrigin = async () => {
		if (!trustedOrigin.trim()) return;
		try {
			await addTrustedOrigin.mutateAsync({ origin: trustedOrigin.trim() });
			setTrustedOrigin("");
			await refresh();
			toast.success("Trusted origin added");
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to add trusted origin",
			);
		}
	};

	return (
		<div className="space-y-4">
			<CardHeader className="px-0 pt-0">
				<CardTitle className="text-xl">Abhash SSO</CardTitle>
				<CardDescription>
					Self-hosted OIDC and SAML provider management for this personal fork.
				</CardDescription>
			</CardHeader>

			<div className="grid gap-4 md:grid-cols-3">
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<KeyRound className="h-4 w-4" />
							OIDC
						</CardTitle>
						<CardDescription>
							Use Google Workspace, GitHub Enterprise, Authentik, Keycloak, or
							any provider with discovery metadata.
						</CardDescription>
					</CardHeader>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<ShieldCheck className="h-4 w-4" />
							SAML
						</CardTitle>
						<CardDescription>
							Use an IdP entry point and certificate when your identity provider
							is SAML-first.
						</CardDescription>
					</CardHeader>
				</Card>
				<Card>
					<CardHeader>
						<CardTitle className="flex items-center gap-2 text-base">
							<Globe2 className="h-4 w-4" />
							Trusted Origins
						</CardTitle>
						<CardDescription>
							Add issuer origins here when Better Auth needs to trust them
							during provider updates.
						</CardDescription>
					</CardHeader>
				</Card>
			</div>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">
						{existingProvider ? "Edit Provider" : "Create Provider"}
					</CardTitle>
					<CardDescription>
						Provider IDs should be stable, lowercase identifiers such as
						`google-workspace` or `authentik`.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					<div className="grid gap-4 md:grid-cols-2">
						<div className="space-y-2">
							<span className="text-sm font-medium">Provider type</span>
							<Select
								value={providerType}
								onValueChange={(value) =>
									setProviderType(value as ProviderType)
								}
							>
								<SelectTrigger>
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="oidc">OIDC</SelectItem>
									<SelectItem value="saml">SAML</SelectItem>
								</SelectContent>
							</Select>
						</div>
						<div className="space-y-2">
							<span className="text-sm font-medium">Provider ID</span>
							<Input
								placeholder="google-workspace"
								value={form.providerId}
								onChange={(event) => setField("providerId", event.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<span className="text-sm font-medium">Email domain</span>
							<Input
								placeholder="example.com"
								value={form.domain}
								onChange={(event) => setField("domain", event.target.value)}
							/>
						</div>
						<div className="space-y-2">
							<span className="text-sm font-medium">Issuer URL</span>
							<Input
								placeholder="https://accounts.google.com"
								value={form.issuer}
								onChange={(event) => setField("issuer", event.target.value)}
							/>
						</div>
					</div>

					{providerType === "oidc" ? (
						<div className="grid gap-4 md:grid-cols-2">
							<div className="space-y-2">
								<span className="text-sm font-medium">Client ID</span>
								<Input
									value={form.clientId}
									onChange={(event) => setField("clientId", event.target.value)}
								/>
							</div>
							<div className="space-y-2">
								<span className="text-sm font-medium">Client secret</span>
								<Input
									type="password"
									value={form.clientSecret}
									onChange={(event) =>
										setField("clientSecret", event.target.value)
									}
								/>
							</div>
							<div className="space-y-2">
								<span className="text-sm font-medium">Discovery endpoint</span>
								<Input
									placeholder="https://issuer/.well-known/openid-configuration"
									value={form.discoveryEndpoint}
									onChange={(event) =>
										setField("discoveryEndpoint", event.target.value)
									}
								/>
							</div>
							<div className="space-y-2">
								<span className="text-sm font-medium">Scopes</span>
								<Input
									value={form.scopes}
									onChange={(event) => setField("scopes", event.target.value)}
								/>
							</div>
						</div>
					) : (
						<div className="space-y-4">
							<div className="grid gap-4 md:grid-cols-2">
								<div className="space-y-2">
									<span className="text-sm font-medium">Entry point</span>
									<Input
										placeholder="https://idp.example.com/saml/login"
										value={form.entryPoint}
										onChange={(event) =>
											setField("entryPoint", event.target.value)
										}
									/>
								</div>
								<div className="space-y-2">
									<span className="text-sm font-medium">Audience</span>
									<Input
										placeholder={callbackUrl}
										value={form.audience}
										onChange={(event) =>
											setField("audience", event.target.value)
										}
									/>
								</div>
							</div>
							<div className="space-y-2 block">
								<span className="text-sm font-medium">IdP certificate</span>
								<Textarea
									className="min-h-36 font-mono"
									value={form.cert}
									onChange={(event) => setField("cert", event.target.value)}
								/>
							</div>
						</div>
					)}

					<div className="rounded-md border bg-muted/30 p-3 text-sm">
						<span className="font-medium">Callback URL: </span>
						<span className="break-all text-muted-foreground">
							{callbackUrl}
						</span>
					</div>

					<div className="flex flex-wrap gap-2">
						<Button
							isLoading={register.isPending || update.isPending}
							onClick={saveProvider}
						>
							{existingProvider ? "Update Provider" : "Create Provider"}
						</Button>
						<Button variant="outline" onClick={() => setForm(blankForm)}>
							Clear
						</Button>
					</div>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Configured Providers</CardTitle>
					<CardDescription>
						These providers are available on the sign-in page once their domain
						matches the user's email.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					{providers.length === 0 && !isLoading ? (
						<p className="text-sm text-muted-foreground">
							No SSO providers configured yet.
						</p>
					) : (
						providers.map((provider) => (
							<div
								className="flex flex-col gap-3 rounded-md border p-3 md:flex-row md:items-center md:justify-between"
								key={provider.providerId}
							>
								<div className="space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-medium">{provider.providerId}</span>
										<Badge variant={provider.samlConfig ? "blue" : "green"}>
											{provider.samlConfig ? "SAML" : "OIDC"}
										</Badge>
									</div>
									<p className="break-all text-sm text-muted-foreground">
										{provider.domain} - {provider.issuer}
									</p>
								</div>
								<div className="flex gap-2">
									<Button
										size="sm"
										variant="outline"
										onClick={() => editProvider(provider)}
									>
										Edit
									</Button>
									<Button
										size="sm"
										variant="destructive"
										onClick={() => onDelete(provider.providerId)}
									>
										<Trash2 className="h-4 w-4" />
										Delete
									</Button>
								</div>
							</div>
						))
					)}
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle className="text-base">Trusted Origins</CardTitle>
					<CardDescription>
						Keep issuer origins here when your SSO provider rotates or changes
						metadata endpoints.
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="flex flex-col gap-2 md:flex-row">
						<Input
							placeholder="https://issuer.example.com"
							value={trustedOrigin}
							onChange={(event) => setTrustedOrigin(event.target.value)}
						/>
						<Button
							className="md:w-36"
							isLoading={addTrustedOrigin.isPending}
							onClick={onAddTrustedOrigin}
						>
							Add Origin
						</Button>
					</div>
					<div className="flex flex-wrap gap-2">
						{trustedOrigins.map((origin) => (
							<Badge
								className="h-auto cursor-pointer px-2 py-1"
								key={origin}
								variant="outline"
								onClick={async () => {
									await removeTrustedOrigin.mutateAsync({ origin });
									await refresh();
								}}
							>
								{origin}
							</Badge>
						))}
						{trustedOrigins.length === 0 && (
							<p className="text-sm text-muted-foreground">
								No trusted origins added.
							</p>
						)}
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
