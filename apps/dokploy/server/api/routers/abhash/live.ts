import { getLiveServices } from "@dokploy/server/services/abhash/live-services";
import { createTRPCRouter, withPermission } from "../../trpc";

export const abhashLiveRouter = createTRPCRouter({
	services: withPermission("docker", "read").query(({ ctx }) =>
		getLiveServices(ctx.session.activeOrganizationId),
	),
});
