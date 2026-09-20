import { sso } from "@better-auth/sso";

/**
 * The SSO plugin declares `domainVerified` as a model field only when it is
 * built with its own DNS-based domain verification enabled. Better Auth's
 * adapter builds every row strictly from the declared fields, so without the
 * field the column is dropped on read, `"domainVerified" in provider` is false
 * in the callback, and a provider can never become trusted for account linking.
 *
 * Turning the plugin's verification on instead would refuse sign-in outright
 * for any provider that is not domain-verified and add a DNS TXT challenge.
 * The fork grants that trust from an admin toggle, so only the field is added.
 */
export const ssoWithDomainVerified = <T extends Parameters<typeof sso>[0]>(
	options: T,
) => {
	const plugin = sso(options);
	const fields = (
		plugin as unknown as {
			schema?: {
				ssoProvider?: {
					fields?: Record<string, { type: string; required: boolean }>;
				};
			};
		}
	).schema?.ssoProvider?.fields;
	if (fields && !fields.domainVerified) {
		fields.domainVerified = { type: "boolean", required: false };
	}
	return plugin;
};
