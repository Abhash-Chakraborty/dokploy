import type { GetServerSidePropsContext } from "next";

/**
 * Sessions moved under Security & Devices, which is the single place for
 * account security (passkeys + active sessions). Kept as a redirect so
 * existing links and bookmarks still resolve.
 */
const SessionsRedirect = () => null;

export default SessionsRedirect;

export async function getServerSideProps(_ctx: GetServerSidePropsContext) {
	return {
		redirect: {
			permanent: false,
			destination: "/dashboard/settings/devices",
		},
	};
}
