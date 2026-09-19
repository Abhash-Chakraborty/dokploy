import type { SVGProps } from "react";

/**
 * Simplified marks for the mesh providers, drawn inline so the settings page
 * pulls nothing from a third party.
 */
export const NetBirdIcon = (props: SVGProps<SVGSVGElement>) => (
	<svg
		viewBox="0 0 24 24"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		{...props}
	>
		<title>NetBird</title>
		<path
			d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7L12 2.5Z"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinejoin="round"
		/>
		<path
			d="M8.2 14.6c1.6-4 3.4-6 5.6-6.2-.4 1.2-.4 2.2 0 3l2 .2c-1 2.4-2.9 3.7-5.6 3.8l-.7 1.8"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
		/>
	</svg>
);

export const TailscaleIcon = (props: SVGProps<SVGSVGElement>) => (
	<svg
		viewBox="0 0 24 24"
		fill="none"
		xmlns="http://www.w3.org/2000/svg"
		aria-hidden="true"
		{...props}
	>
		<title>Tailscale with Headscale</title>
		{[5, 12, 19].map((cx) =>
			[5, 12, 19].map((cy) => (
				<circle
					key={`${cx}-${cy}`}
					cx={cx}
					cy={cy}
					r="2.1"
					fill="currentColor"
					opacity={cy === 12 || cx === 12 ? 1 : 0.35}
				/>
			)),
		)}
	</svg>
);

export const MeshIcon = ({
	kind,
	...props
}: SVGProps<SVGSVGElement> & { kind: "netbird" | "headscale" }) =>
	kind === "netbird" ? (
		<NetBirdIcon {...props} />
	) : (
		<TailscaleIcon {...props} />
	);
