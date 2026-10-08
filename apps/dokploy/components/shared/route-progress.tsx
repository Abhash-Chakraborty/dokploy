import { useRouter } from "next/router";
import { useEffect, useRef, useState } from "react";

/**
 * A thin bar at the top while a page loads. Every dashboard page runs
 * getServerSideProps, so a click waits on the server before anything changes;
 * without this the dashboard looked like it ignored the click.
 */
export const RouteProgress = () => {
	const router = useRouter();
	const [progress, setProgress] = useState<number | null>(null);
	const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

	useEffect(() => {
		const clear = () => {
			for (const timer of timers.current) clearTimeout(timer);
			timers.current = [];
		};
		const start = (url: string, { shallow }: { shallow: boolean }) => {
			if (shallow || url === router.asPath) return;
			clear();
			// Fast navigations finish before the bar would show; skip the flash.
			timers.current.push(
				setTimeout(() => setProgress(30), 80),
				setTimeout(() => setProgress(60), 400),
				setTimeout(() => setProgress(80), 1200),
			);
		};
		const done = () => {
			clear();
			setProgress((current) => (current === null ? null : 100));
			timers.current.push(setTimeout(() => setProgress(null), 200));
		};
		router.events.on("routeChangeStart", start);
		router.events.on("routeChangeComplete", done);
		router.events.on("routeChangeError", done);
		return () => {
			clear();
			router.events.off("routeChangeStart", start);
			router.events.off("routeChangeComplete", done);
			router.events.off("routeChangeError", done);
		};
	}, [router]);

	if (progress === null) return null;
	return (
		<div
			aria-hidden
			className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5"
		>
			<div
				className="h-full bg-foreground/70 transition-[width,opacity] duration-200 ease-out"
				style={{ width: `${progress}%`, opacity: progress === 100 ? 0 : 1 }}
			/>
		</div>
	);
};
