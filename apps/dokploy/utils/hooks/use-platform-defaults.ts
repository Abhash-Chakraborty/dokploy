import { api } from "@/utils/api";

// Mirrors the server defaults so a page renders with sane values before the
// query returns, instead of polling at a different rate for its first second.
const FALLBACK = {
	liveStatusSeconds: 10,
	listsSeconds: 15,
	logsSeconds: 5,
};

export function usePlatformDefaults() {
	const { data } = api.platformDefaults.get.useQuery(undefined, {
		staleTime: 5 * 60 * 1000,
		refetchOnWindowFocus: false,
	});
	return data;
}

/** Polling interval in milliseconds for one kind of view. */
export function useRefreshInterval(kind: keyof typeof FALLBACK) {
	const data = usePlatformDefaults();
	return (data?.refresh[kind] ?? FALLBACK[kind]) * 1000;
}
