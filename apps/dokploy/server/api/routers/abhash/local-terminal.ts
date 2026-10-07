import {
	getLocalSsh,
	saveLocalSsh,
} from "@dokploy/server/services/abhash/local-terminal";
import { z } from "zod";
import { adminProcedure, createTRPCRouter } from "../../trpc";

export const abhashLocalTerminalRouter = createTRPCRouter({
	get: adminProcedure.query(() => getLocalSsh()),
	save: adminProcedure
		.input(
			z.object({
				port: z.number().int().min(1).max(65_535),
				username: z
					.string()
					.trim()
					.min(1)
					.max(32)
					.regex(/^[a-z_][a-z0-9_.-]*$/i, "Not a valid Unix user name"),
			}),
		)
		.mutation(({ ctx, input }) => saveLocalSsh(input, ctx.user.id)),
});
