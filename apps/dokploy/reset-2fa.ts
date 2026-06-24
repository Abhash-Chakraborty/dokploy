import { findOwner } from "@dokploy/server";
import { db } from "@dokploy/server/db";
import { twoFactor, user } from "@dokploy/server/db/schema";
import { eq } from "drizzle-orm";

(async () => {
	try {
		const targetEmail =
			process.env.DOKPLOY_2FA_RESET_EMAIL || process.env.RESET_2FA_EMAIL;
		const targetUser = targetEmail
			? await db.query.user.findFirst({
					where: eq(user.email, targetEmail.trim()),
				})
			: (await findOwner()).user;

		if (!targetUser) {
			console.log(`No user found for ${targetEmail}`);
			process.exit(1);
		}

		await db.transaction(async (tx) => {
			await tx.delete(twoFactor).where(eq(twoFactor.userId, targetUser.id));
			await tx
				.update(user)
				.set({
					twoFactorEnabled: false,
				})
				.where(eq(user.id, targetUser.id));
		});

		console.log(`2FA reset successful for ${targetUser.email}`);

		process.exit(0);
	} catch (error) {
		console.log("Error resetting 2FA", error);
		process.exit(1);
	}
})();
