// S3 destinations are the Storage tab of the Backups page now.
export default function Page() {
	return null;
}

export function getServerSideProps() {
	return {
		redirect: {
			permanent: false,
			destination: "/dashboard/backups?tab=storage",
		},
	};
}
