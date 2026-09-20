import type { GetServerSidePropsContext } from "next";

/** Merged into the Secrets page as a tab; the old URL still resolves. */
const Page = () => null;

export default Page;

export async function getServerSideProps(_ctx: GetServerSidePropsContext) {
	return {
		redirect: {
			permanent: false,
			destination: "/dashboard/settings/vault?tab=providers",
		},
	};
}
