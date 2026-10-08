import {
	getPlatformDefaults,
	platformDefaultsSchema,
	savePlatformDefaults,
} from "@dokploy/server/services/abhash/platform-defaults";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "../../trpc";

export const abhashPlatformDefaultsRouter = createTRPCRouter({
	// Every signed-in page reads its refresh rates from here.
	get: protectedProcedure.query(() => getPlatformDefaults()),
	save: adminProcedure
		.input(platformDefaultsSchema)
		.mutation(async ({ ctx, input }) => {
			await savePlatformDefaults(input, ctx.user.id);
			return getPlatformDefaults();
		}),
});
