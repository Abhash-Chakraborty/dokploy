import type { GetServerSidePropsContext } from "next";

// Restic repositories and drills moved to the Backups page; old links to the
// repositories tab land on its snapshots tab.
export default function Page() {
	return null;
}

export function getServerSideProps(ctx: GetServerSidePropsContext) {
	const destination =
		ctx.query.tab === "repositories"
			? "/dashboard/backups?tab=snapshots"
			: "/dashboard/backups";
	return { redirect: { permanent: false, destination } };
}
