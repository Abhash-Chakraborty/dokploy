import type { PlacementSwarm } from "../../db/schema/shared";

export const SPREAD_BY_NODE = "node.id";
const MANAGER_ONLY = "node.role==manager";

export interface SpreadOptions {
	spread: boolean;
	/** 0 or undefined means no per-node limit. */
	maxPerNode?: number;
}

export const readSpread = (
	placement: PlacementSwarm | null | undefined,
): Required<SpreadOptions> => ({
	spread: !!placement?.Preferences?.some(
		(preference) => preference.Spread?.SpreadDescriptor === SPREAD_BY_NODE,
	),
	maxPerNode: placement?.MaxReplicas ?? 0,
});

/**
 * Folds the spread choice into an existing placement without touching the
 * constraints or other preferences someone set in Swarm Settings.
 *
 * A service with no placement at all gets "managers only" at deploy time when
 * it has mounts (named volumes live on one node). Writing a placement drops
 * that default, so it is carried over explicitly rather than silently
 * letting replicas land on workers with empty volumes.
 */
export const applySpread = (
	placement: PlacementSwarm | null | undefined,
	options: SpreadOptions,
	hasMounts: boolean,
): PlacementSwarm | null => {
	const next: PlacementSwarm = placement
		? { ...placement }
		: { Constraints: hasMounts ? [MANAGER_ONLY] : [] };

	const others = (next.Preferences ?? []).filter(
		(preference) => preference.Spread?.SpreadDescriptor !== SPREAD_BY_NODE,
	);
	next.Preferences = options.spread
		? [{ Spread: { SpreadDescriptor: SPREAD_BY_NODE } }, ...others]
		: others;
	if (next.Preferences.length === 0) delete next.Preferences;

	if (options.maxPerNode && options.maxPerNode > 0) {
		next.MaxReplicas = options.maxPerNode;
	} else {
		delete next.MaxReplicas;
	}

	const untouched =
		!placement &&
		!next.Preferences &&
		next.MaxReplicas === undefined &&
		(next.Constraints?.length ?? 0) === (hasMounts ? 1 : 0);
	return untouched ? null : next;
};

/** `docker service update` flags for a stack service. */
export const spreadUpdateFlags = (options: SpreadOptions): string[] => [
	options.spread
		? `--placement-pref-add=spread=${SPREAD_BY_NODE}`
		: `--placement-pref-rm=spread=${SPREAD_BY_NODE}`,
	`--replicas-max-per-node=${options.maxPerNode && options.maxPerNode > 0 ? options.maxPerNode : 0}`,
];
