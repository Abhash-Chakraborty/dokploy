import { validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { KeyRound } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import { useRouter } from "next/router";
import type { ReactElement } from "react";
import superjson from "superjson";
import { VaultSettings } from "@/components/abhash/vault/vault-settings";
import { ShowVaultProviders } from "@/components/dashboard/settings/vault/show-vault-providers";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appRouter } from "@/server/api/root";
import { api } from "@/utils/api";

const TABS = ["vault", "providers"] as const;
type Tab = (typeof TABS)[number];

const Page = () => {
	const router = useRouter();
	const { data: permissions } = api.user.getPermissions.useQuery();
	// The merged page replaced two nav entries that carried their own gates.
	const canSeeProviders = !!permissions?.vaultProvider.read;
	const raw = router.query.tab;
	const requested = Array.isArray(raw) ? raw[0] : raw;
	const wanted: Tab = TABS.includes(requested as Tab)
		? (requested as Tab)
		: "vault";
	const tab: Tab =
		wanted === "providers" && !canSeeProviders ? "vault" : wanted;

	return (
		<PageContainer>
			<PageHeader
				icon={<KeyRound className="size-5" />}
				title="Secrets"
				description="Values your services read by reference, so they are never written into a config in plain text."
			/>
			<Tabs
				value={tab}
				onValueChange={(next) => {
					// Keeps the tab shareable and survives a reload.
					void router.replace(
						{ pathname: router.pathname, query: { tab: next } },
						undefined,
						{ shallow: true },
					);
				}}
			>
				<TabsList>
					<TabsTrigger value="vault">Dokploy vault</TabsTrigger>
					{canSeeProviders && (
						<TabsTrigger value="providers">External providers</TabsTrigger>
					)}
				</TabsList>
				<TabsContent value="vault" className="mt-4">
					<VaultSettings embedded />
				</TabsContent>
				{canSeeProviders && (
					<TabsContent value="providers" className="mt-4">
						<ShowVaultProviders embedded />
					</TabsContent>
				)}
			</Tabs>
		</PageContainer>
	);
};

export default Page;

Page.getLayout = (page: ReactElement) => (
	<DashboardLayout metaName="Secrets">{page}</DashboardLayout>
);

export async function getServerSideProps(ctx: GetServerSidePropsContext) {
	const { req, res } = ctx;
	const { user, session } = await validateRequest(req);
	if (!user) {
		return { redirect: { permanent: false, destination: "/" } };
	}
	const helpers = createServerSideHelpers({
		router: appRouter,
		ctx: {
			req: req as any,
			res: res as any,
			db: null as any,
			session: session as any,
			user: user as any,
		},
		transformer: superjson,
	});
	await helpers.user.get.prefetch();
	await helpers.vault.status.prefetch();
	return { props: { trpcState: helpers.dehydrate() } };
}
