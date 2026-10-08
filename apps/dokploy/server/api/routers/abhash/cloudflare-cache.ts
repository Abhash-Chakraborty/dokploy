import { findDnsProviderInOrganization } from "@dokploy/server";
import {
	CloudflareError,
	cacheRuleInput,
	deleteCacheRule,
	getZoneCacheSettings,
	listCacheRules,
	purgeInput,
	purgeZoneCache,
	saveCacheRule,
	setSmartTieredCache,
	updateZoneSetting,
	zoneSettingIds,
	zoneSettingValue,
} from "@dokploy/server/services/abhash/cloudflare-cache";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { audit } from "@/server/api/utils/audit";
import { createTRPCRouter, withPermission } from "../../trpc";

const zoneInput = z.object({
	dnsProviderId: z.string().min(1),
	zoneId: z.string().regex(/^[a-f0-9]{32}$/i, "Not a Cloudflare zone id"),
});

const tokenFor = async (dnsProviderId: string, organizationId: string) => {
	const provider = await findDnsProviderInOrganization(
		dnsProviderId,
		organizationId,
	);
	if (provider.config.providerType !== "cloudflare") {
		throw new TRPCError({
			code: "BAD_REQUEST",
			message: "Caching controls need a Cloudflare DNS provider",
		});
	}
	return { token: provider.config.apiToken, provider };
};

const run = async <T>(work: () => Promise<T>) => {
	try {
		return await work();
	} catch (error) {
		if (error instanceof CloudflareError) {
			throw new TRPCError({
				code: error.status === 409 ? "CONFLICT" : "BAD_REQUEST",
				message: error.message,
			});
		}
		throw error;
	}
};

export const abhashCloudflareCacheRouter = createTRPCRouter({
	settings: withPermission("dnsProvider", "read")
		.input(zoneInput)
		.query(async ({ ctx, input }) => {
			const { token } = await tokenFor(
				input.dnsProviderId,
				ctx.session.activeOrganizationId,
			);
			return run(() => getZoneCacheSettings(token, input.zoneId));
		}),

	updateSetting: withPermission("dnsProvider", "update")
		.input(
			zoneInput.extend({
				id: z.enum(zoneSettingIds),
				value: zoneSettingValue,
			}),
		)
		.mutation(async ({ ctx, input }) => {
			const { token, provider } = await tokenFor(
				input.dnsProviderId,
				ctx.session.activeOrganizationId,
			);
			await run(() =>
				updateZoneSetting(token, input.zoneId, input.id, input.value),
			);
			await audit(ctx, {
				action: "update",
				resourceType: "dnsProvider",
				resourceId: provider.dnsProviderId,
				resourceName: `${provider.name}: ${input.id} = ${input.value}`,
			});
			return true;
		}),

	setTieredCache: withPermission("dnsProvider", "update")
		.input(zoneInput.extend({ enabled: z.boolean() }))
		.mutation(async ({ ctx, input }) => {
			const { token } = await tokenFor(
				input.dnsProviderId,
				ctx.session.activeOrganizationId,
			);
			await run(() => setSmartTieredCache(token, input.zoneId, input.enabled));
			return true;
		}),

	rules: withPermission("dnsProvider", "read")
		.input(zoneInput)
		.query(async ({ ctx, input }) => {
			const { token } = await tokenFor(
				input.dnsProviderId,
				ctx.session.activeOrganizationId,
			);
			return run(() => listCacheRules(token, input.zoneId));
		}),

	saveRule: withPermission("dnsProvider", "update")
		.input(zoneInput.extend({ rule: cacheRuleInput }))
		.mutation(async ({ ctx, input }) => {
			const { token, provider } = await tokenFor(
				input.dnsProviderId,
				ctx.session.activeOrganizationId,
			);
			await run(() => saveCacheRule(token, input.zoneId, input.rule));
			await audit(ctx, {
				action: input.rule.id ? "update" : "create",
				resourceType: "dnsProvider",
				resourceId: provider.dnsProviderId,
				resourceName: `${provider.name}: cache rule "${input.rule.name}"`,
			});
			return true;
		}),

	deleteRule: withPermission("dnsProvider", "update")
		.input(zoneInput.extend({ ruleId: z.string().min(1) }))
		.mutation(async ({ ctx, input }) => {
			const { token, provider } = await tokenFor(
				input.dnsProviderId,
				ctx.session.activeOrganizationId,
			);
			await run(() => deleteCacheRule(token, input.zoneId, input.ruleId));
			await audit(ctx, {
				action: "delete",
				resourceType: "dnsProvider",
				resourceId: provider.dnsProviderId,
				resourceName: `${provider.name}: cache rule`,
			});
			return true;
		}),

	purge: withPermission("dnsProvider", "update")
		.input(zoneInput.extend({ purge: purgeInput }))
		.mutation(async ({ ctx, input }) => {
			const { token, provider } = await tokenFor(
				input.dnsProviderId,
				ctx.session.activeOrganizationId,
			);
			await run(() => purgeZoneCache(token, input.zoneId, input.purge));
			await audit(ctx, {
				action: "update",
				resourceType: "dnsProvider",
				resourceId: provider.dnsProviderId,
				resourceName: `${provider.name}: purged ${input.purge.kind}`,
			});
			return true;
		}),
});
