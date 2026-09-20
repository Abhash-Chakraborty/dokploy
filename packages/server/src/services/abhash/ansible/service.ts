import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../../db";
import {
	type AnsibleTargets,
	abhashAnsibleProject,
	abhashAnsibleTemplate,
} from "../../../db/schema";
import { defineJob } from "../jobs/registry";
import { resolveSecretRefs } from "../vault/secrets";
import { resolveTargets } from "./inventory";
import { PLATFORM_FILES, PLATFORM_PROJECT } from "./playbooks";
import { runPlaybook } from "./runner";

export const PING_PLAYBOOK = `- name: Check Dokploy can reach and manage these servers
  hosts: dokploy
  gather_facts: true
  tasks:
    - name: Report what we found
      ansible.builtin.debug:
        msg: "{{ inventory_hostname }}: {{ ansible_distribution }} {{ ansible_distribution_version }}, kernel {{ ansible_kernel }}"
`;

/** Every organization gets this on first use, so there is something to run. */
export const ensureStarterProject = async (
	organizationId: string,
	userId: string | null,
) => {
	// The shipped playbooks are kept in step with the code on every read.
	await db
		.insert(abhashAnsibleProject)
		.values({
			organizationId,
			name: PLATFORM_PROJECT,
			description: "Shipped with Dokploy: baseline, cleanup and patching",
			files: PLATFORM_FILES,
			createdBy: userId,
		})
		.onConflictDoUpdate({
			target: [abhashAnsibleProject.organizationId, abhashAnsibleProject.name],
			set: { files: PLATFORM_FILES, updatedAt: new Date() },
		});
	const existing = await db.query.abhashAnsibleProject.findFirst({
		where: and(
			eq(abhashAnsibleProject.organizationId, organizationId),
			eq(abhashAnsibleProject.name, "Starter"),
		),
	});
	if (existing) return existing;
	const [created] = await db
		.insert(abhashAnsibleProject)
		.values({
			organizationId,
			name: "Starter",
			description: "Example playbooks, safe to edit or delete",
			files: { "ping.yml": PING_PLAYBOOK },
			createdBy: userId,
		})
		.onConflictDoNothing()
		.returning();
	return (
		created ??
		(await db.query.abhashAnsibleProject.findFirst({
			where: and(
				eq(abhashAnsibleProject.organizationId, organizationId),
				eq(abhashAnsibleProject.name, "Starter"),
			),
		}))
	);
};

export const listProjects = (organizationId: string) =>
	db.query.abhashAnsibleProject.findMany({
		where: eq(abhashAnsibleProject.organizationId, organizationId),
		orderBy: [asc(abhashAnsibleProject.name)],
	});

export const listTemplates = (organizationId: string) =>
	db.query.abhashAnsibleTemplate.findMany({
		where: eq(abhashAnsibleTemplate.organizationId, organizationId),
		orderBy: [asc(abhashAnsibleTemplate.name)],
	});

export const findTemplate = async (organizationId: string, id: string) => {
	const template = await db.query.abhashAnsibleTemplate.findFirst({
		where: and(
			eq(abhashAnsibleTemplate.id, id),
			eq(abhashAnsibleTemplate.organizationId, organizationId),
		),
	});
	if (!template) throw new Error("Playbook run not found");
	const project = await db.query.abhashAnsibleProject.findFirst({
		where: eq(abhashAnsibleProject.id, template.projectId),
	});
	if (!project) throw new Error("Its project is gone");
	return { template, project };
};

const resolveVars = async (
	organizationId: string,
	vars: Record<string, string>,
) => {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(vars)) {
		// Secrets are resolved into the run's vars file and never stored.
		out[name] =
			(await resolveSecretRefs(value, {
				organizationId,
				projectId: organizationId,
			})) ?? value;
	}
	return out;
};

export const ansibleRunJob = defineJob({
	type: "ansible.run",
	queue: "abhash-ansible",
	input: z.object({
		organizationId: z.string(),
		templateId: z.string(),
		checkMode: z.boolean().optional(),
		limit: z.string().nullable().optional(),
	}),
	title: (input) =>
		input.checkMode === false ? "Ansible: apply" : "Ansible: check",
	// Check mode changes nothing, so only an apply needs approval.
	destructive: (input) => input.checkMode === false,
	timeoutMs: 45 * 60_000,
	lock: (input) => ({ key: `ansible:${input.templateId}`, limit: 1 }),
	run: async ({ input, log, signal }) => {
		const { template, project } = await findTemplate(
			input.organizationId,
			input.templateId,
		);
		const hosts = await resolveTargets(
			input.organizationId,
			template.targets as AnsibleTargets,
		);
		if (hosts.length === 0) {
			throw new Error("No servers matched, or none has an SSH key");
		}
		const checkMode = input.checkMode ?? template.checkMode;
		const result = await runPlaybook({
			files: project.files,
			playbook: template.playbook,
			hosts,
			extraVars: await resolveVars(input.organizationId, template.extraVars),
			checkMode,
			become: template.become,
			forks: template.forks,
			limit: input.limit ?? template.limitPattern,
			tags: template.tags,
			signal,
			log,
		});
		if (result.exitCode !== 0) {
			throw new Error(
				`ansible-playbook exited with ${result.exitCode}; see the log`,
			);
		}
		return { checkMode, ...result };
	},
});

export const updateTemplateSchedule = async (
	organizationId: string,
	templateId: string,
) => {
	const { template } = await findTemplate(organizationId, templateId);
	const { removeSchedule, upsertSchedule } = await import("../jobs/scheduler");
	const id = `ansible:${template.id}`;
	if (!template.cronExpression || !template.enabled) {
		await removeSchedule("ansible.run", id).catch(() => false);
		return false;
	}
	await upsertSchedule({
		id,
		type: "ansible.run",
		input: {
			organizationId,
			templateId: template.id,
			checkMode: template.checkMode,
		},
		cron: template.cronExpression,
		timezone: template.timezone,
		organizationId,
	});
	return true;
};
