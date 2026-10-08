// Every backup is listed on the Backups page now.
export default function Page() {
	return null;
}

export function getServerSideProps() {
	return { redirect: { permanent: false, destination: "/dashboard/backups" } };
}
