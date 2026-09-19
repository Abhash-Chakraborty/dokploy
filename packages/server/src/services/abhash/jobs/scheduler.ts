import { getQueue } from "./queue";
import { getJobDefinition } from "./registry";

export interface ScheduleSpec {
	/** Stable id: re-upserting it replaces the schedule instead of adding one. */
	id: string;
	type: string;
	input: unknown;
	cron: string;
	timezone?: string;
	organizationId: string | null;
}

export const upsertSchedule = async (spec: ScheduleSpec) => {
	const definition = getJobDefinition(spec.type);
	if (!definition) throw new Error(`Unknown job type: ${spec.type}`);
	const input = definition.input.parse(spec.input);
	await getQueue(definition.queue).upsertJobScheduler(
		spec.id,
		{ pattern: spec.cron, tz: spec.timezone ?? "UTC" },
		{
			name: spec.type,
			data: {
				scheduled: {
					type: spec.type,
					input,
					organizationId: spec.organizationId,
					scheduleId: spec.id,
				},
			},
			opts: {
				attempts: definition.attempts ?? 1,
				removeOnComplete: true,
				removeOnFail: true,
			},
		},
	);
};

export const removeSchedule = async (type: string, id: string) => {
	const definition = getJobDefinition(type);
	if (!definition) return false;
	return getQueue(definition.queue).removeJobScheduler(id);
};
