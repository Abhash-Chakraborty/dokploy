import { validateRequest } from "@dokploy/server";
import { createServerSideHelpers } from "@trpc/react-query/server";
import { ArrowLeft } from "lucide-react";
import type { GetServerSidePropsContext } from "next";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { ReactElement } from "react";
import superjson from "superjson";
import { ShowDnsRecords } from "@/components/dashboard/settings/dns/show-dns-records";
import { DashboardLayout } from "@/components/layouts/dashboard-layout";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/utils/api";

const CloudflareCaching = dynamic(
	() =>
		import("@/components/abhash/cloudflare/cloudflare-caching").then(
			(m) => m.CloudflareCaching,
		),
	{ ssr: false },
);

import { appRouter } from "@/server/api/root";

interface Props {
	dnsProviderId: string;
	zoneId: string;
}

const Page = ({ dnsProviderId, zoneId }: Props) => {
	const { data: provider } = api.dnsProvider.one.useQuery({ dnsProviderId });
	const { data: zones } = api.dnsProvider.listZones.useQuery({ dnsProviderId });
	if (provider && provider.providerType !== "cloudflare") {
		return <ShowDnsRecords dnsProviderId={dnsProviderId} zoneId={zoneId} />;
	}
	const zoneName = zones?.find((zone) => zone.id === zoneId)?.name ?? "";
	const records = (
		<ShowDnsRecords dnsProviderId={dnsProviderId} zoneId={zoneId} embedded />
	);
	return (
		<PageContainer>
			<PageHeader
				title={
					<span className="flex items-center gap-2">
						<Link
							href={`/dashboard/settings/dns/${dnsProviderId}`}
							className="text-muted-foreground hover:text-foreground"
							aria-label="Back to zones"
						>
							<ArrowLeft className="size-5" />
						</Link>
						{zoneName || "Zone"}
					</span>
				}
				description={`Through ${provider?.name ?? "Cloudflare"}. Changes go straight to Cloudflare.`}
			/>
			<Tabs defaultValue="records" className="gap-6">
				<TabsList>
					<TabsTrigger value="records">DNS records</TabsTrigger>
					<TabsTrigger value="caching">Caching</TabsTrigger>
				</TabsList>
				<TabsContent value="records">{records}</TabsContent>
				<TabsContent value="caching">
					<CloudflareCaching
						dnsProviderId={dnsProviderId}
						zoneId={zoneId}
						zoneName={zoneName}
					/>
				</TabsContent>
			</Tabs>
		</PageContainer>
	);
};

export default Page;

Page.getLayout = (page: ReactElement) => {
	return <DashboardLayout metaName="DNS Providers">{page}</DashboardLayout>;
};

export async function getServerSideProps(
	ctx: GetServerSidePropsContext<{ dnsProviderId: string; zoneId: string }>,
) {
	const { req, res, params } = ctx;
	const { user, session } = await validateRequest(req);
	if (
		!user ||
		user.role === "member" ||
		!params?.dnsProviderId ||
		!params?.zoneId
	) {
		return {
			redirect: {
				permanent: false,
				destination: "/",
			},
		};
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
	await helpers.settings.isCloud.prefetch();

	return {
		props: {
			trpcState: helpers.dehydrate(),
			dnsProviderId: params.dnsProviderId,
			zoneId: params.zoneId,
		},
	};
}
