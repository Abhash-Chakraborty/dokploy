import { db } from "@dokploy/server/db";
import { abhashSettings, webServerSettings } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";

// Recovery for a login lockout (identity provider down, every usable method
// switched off). Run inside the Dokploy container:
//   docker exec -it $(docker ps -qf name=^dokploy\\.) pnpm run reset-sso
// Turns SSO enforcement off and re-enables every login method. SSO itself and
// its providers are left configured.
(async () => {
	try {
		await db.transaction(async (tx) => {
			await tx
				.update(abhashSettings)
				.set({
					value: { enabled: false, allowPasskey: true },
					updatedBy: "reset-sso",
					updatedAt: new Date(),
				})
				.where(eq(abhashSettings.key, "sso.enforce"));
			await tx.update(webServerSettings).set({
				authMethodsConfig: {
					emailPassword: true,
					github: true,
					google: true,
					passkey: true,
				},
			});
		});
		console.log(
			"SSO enforcement is off and every login method is enabled. Changes apply within a few seconds.",
		);
		process.exit(0);
	} catch (error) {
		console.log("Error resetting login settings", error);
		process.exit(1);
	}
})();
