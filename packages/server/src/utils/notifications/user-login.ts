import { db } from "@dokploy/server/db";
import { notifications } from "@dokploy/server/db/schema";
import { format } from "date-fns";
import { and, eq } from "drizzle-orm";
import {
	sendCustomNotification,
	sendDiscordNotification,
	sendEmailNotification,
	sendGotifyNotification,
	sendLarkNotification,
	sendMattermostNotification,
	sendNtfyNotification,
	sendPushoverNotification,
	sendResendNotification,
	sendSlackNotification,
	sendTeamsNotification,
	sendTelegramNotification,
} from "./utils";

interface UserLoginNotificationProps {
	organizationId: string;
	userEmail: string;
	userRole?: string;
	ipAddress?: string;
	userAgent?: string;
}

/**
 * Sends a "new login" notification to every channel in the organization that
 * has `userLogin` enabled. Triggered from the Better Auth session create hook
 * so the user is alerted on each new sign-in (a security signal).
 */
export const sendUserLoginNotifications = async ({
	organizationId,
	userEmail,
	userRole,
	ipAddress,
	userAgent,
}: UserLoginNotificationProps) => {
	try {
		const date = new Date();
		const unixDate = ~~(Number(date) / 1000);
		const formattedDate = date.toLocaleString();
		const ip = ipAddress || "unknown";
		const agent = userAgent || "unknown";

		const notificationList = await db.query.notifications.findMany({
			where: and(
				eq(notifications.userLogin, true),
				eq(notifications.organizationId, organizationId),
			),
			with: {
				email: true,
				discord: true,
				telegram: true,
				slack: true,
				resend: true,
				gotify: true,
				ntfy: true,
				mattermost: true,
				custom: true,
				lark: true,
				pushover: true,
				teams: true,
			},
		});

		for (const notification of notificationList) {
			const {
				email,
				resend,
				discord,
				telegram,
				slack,
				gotify,
				ntfy,
				mattermost,
				custom,
				lark,
				pushover,
				teams,
			} = notification;

			const title = "New Login to Dokploy";
			const plain = `Account: ${userEmail}\nIP: ${ip}\nDevice: ${agent}\nDate: ${formattedDate}`;

			try {
				if (email) {
					await sendEmailNotification(
						email,
						title,
						`<b>${title}</b><br/><br/>Account: ${userEmail}<br/>IP: ${ip}<br/>Device: ${agent}<br/>Date: ${formattedDate}`,
					);
				}

				if (resend) {
					await sendResendNotification(
						resend,
						title,
						`<b>${title}</b><br/><br/>Account: ${userEmail}<br/>IP: ${ip}<br/>Device: ${agent}<br/>Date: ${formattedDate}`,
					);
				}

				if (discord) {
					const decorate = (decoration: string, text: string) =>
						`${discord.decoration ? decoration : ""} ${text}`.trim();

					await sendDiscordNotification(discord, {
						title: decorate(">", "`🔐` New Login to Dokploy"),
						color: 0x5865f2,
						fields: [
							{
								name: decorate("`👤`", "Account"),
								value: userEmail,
								inline: false,
							},
							{ name: decorate("`🌐`", "IP"), value: ip, inline: true },
							{
								name: decorate("`📅`", "Date"),
								value: `<t:${unixDate}:f>`,
								inline: true,
							},
							{ name: decorate("`💻`", "Device"), value: agent, inline: false },
						],
						timestamp: date.toISOString(),
						footer: { text: "Dokploy Login Notification" },
					});
				}

				if (gotify) {
					const decorate = (decoration: string, text: string) =>
						`${gotify.decoration ? decoration : ""} ${text}\n`;
					await sendGotifyNotification(
						gotify,
						decorate("🔐", title),
						`${decorate("👤", `Account: ${userEmail}`)}${decorate(
							"🌐",
							`IP: ${ip}`,
						)}${decorate("🕒", `Date: ${formattedDate}`)}`,
					);
				}

				if (ntfy) {
					await sendNtfyNotification(
						ntfy,
						title,
						"closed_lock_with_key",
						"",
						plain,
					);
				}

				if (telegram) {
					await sendTelegramNotification(
						telegram,
						`<b>🔐 New Login to Dokploy</b>\n\n<b>Account:</b> ${userEmail}\n<b>IP:</b> ${ip}\n<b>Device:</b> ${agent}\n<b>Date:</b> ${format(
							date,
							"PP pp",
						)}`,
					);
				}

				if (slack) {
					await sendSlackNotification(slack, {
						channel: slack.channel,
						attachments: [
							{
								color: "#5865F2",
								pretext: ":closed_lock_with_key: *New Login to Dokploy*",
								fields: [
									{ title: "Account", value: userEmail, short: true },
									{ title: "IP", value: ip, short: true },
									{ title: "Device", value: agent, short: false },
									{ title: "Date", value: formattedDate, short: true },
								],
							},
						],
					});
				}

				if (mattermost) {
					await sendMattermostNotification(mattermost, {
						text: `**🔐 New Login to Dokploy**\n\n**Account:** ${userEmail}\n**IP:** ${ip}\n**Device:** ${agent}\n**Date:** ${format(
							date,
							"PP pp",
						)}`,
						channel: mattermost.channel,
						username: mattermost.username || "Dokploy",
					});
				}

				if (custom) {
					try {
						await sendCustomNotification(custom, {
							title,
							message: `New login to your Dokploy account ${userEmail}`,
							timestamp: date.toISOString(),
							date: formattedDate,
							account: userEmail,
							role: userRole ?? "",
							ip,
							userAgent: agent,
							status: "info",
							type: "user-login",
						});
					} catch (error) {
						console.log(error);
					}
				}

				if (lark) {
					await sendLarkNotification(lark, {
						msg_type: "interactive",
						card: {
							schema: "2.0",
							config: {
								update_multi: true,
								style: {
									text_size: {
										normal_v2: {
											default: "normal",
											pc: "normal",
											mobile: "heading",
										},
									},
								},
							},
							header: {
								title: {
									tag: "plain_text",
									content: "🔐 New Login to Dokploy",
								},
								subtitle: { tag: "plain_text", content: "" },
								template: "blue",
								padding: "12px 12px 12px 12px",
							},
							body: {
								direction: "vertical",
								padding: "12px 12px 12px 12px",
								elements: [
									{
										tag: "markdown",
										content: `**Account:**\n${userEmail}\n\n**IP:**\n${ip}\n\n**Device:**\n${agent}\n\n**Date:**\n${format(
											date,
											"PP pp",
										)}`,
										text_align: "left",
										text_size: "normal_v2",
									},
								],
							},
						},
					});
				}

				if (pushover) {
					await sendPushoverNotification(pushover, title, plain);
				}

				if (teams) {
					await sendTeamsNotification(teams, {
						title: "🔐 New Login to Dokploy",
						facts: [
							{ name: "Account", value: userEmail },
							{ name: "IP", value: ip },
							{ name: "Device", value: agent },
							{ name: "Date", value: format(date, "PP pp") },
						],
					});
				}
			} catch (error) {
				console.log(error);
			}
		}
	} catch (error) {
		console.error("[Dokploy] Login notifications failed:", error);
	}
};
