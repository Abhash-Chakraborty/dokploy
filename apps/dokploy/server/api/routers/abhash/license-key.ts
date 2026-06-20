import { z } from "zod";
import {
	adminProcedure,
	createTRPCRouter,
	protectedProcedure,
} from "@/server/api/trpc";

const PERSONAL_LICENSE_KEY = "ABHASH-PERSONAL-SELF-HOSTED";

export const abhashLicenseKeyRouter = createTRPCRouter({
	activate: adminProcedure
		.input(z.object({ licenseKey: z.string().min(1) }))
		.mutation(() => ({ success: true })),

	validate: adminProcedure.mutation(() => true),

	deactivate: adminProcedure.mutation(() => ({ success: true })),

	getEnterpriseSettings: adminProcedure.query(() => ({
		enableEnterpriseFeatures: true,
		licenseKey: PERSONAL_LICENSE_KEY,
	})),

	haveValidLicenseKey: protectedProcedure.query(() => true),

	updateEnterpriseSettings: adminProcedure
		.input(
			z.object({
				enableEnterpriseFeatures: z.boolean().optional(),
			}),
		)
		.mutation(() => true),
});
