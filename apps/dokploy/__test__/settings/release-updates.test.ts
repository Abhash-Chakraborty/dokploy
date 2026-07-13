import {
	clearUpdateDataCache,
	getDokployUpdateArguments,
	getUpdateData,
	type UpdateCheckDependencies,
} from "@dokploy/server/services/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const releaseResponse = (
	overrides: Partial<{
		draft: boolean;
		prerelease: boolean;
		tag_name: string;
	}> = {},
) =>
	new Response(
		JSON.stringify({
			draft: false,
			prerelease: false,
			tag_name: "v0.29.12",
			...overrides,
		}),
		{ status: 200 },
	);

const createDependencies = (
	response: Response | Error = releaseResponse(),
	imageAvailable = true,
) => {
	const fetchMock = vi.fn(async () => {
		if (response instanceof Error) throw response;
		return response;
	});
	const imageExists = vi.fn(async () => imageAvailable);
	const dependencies: UpdateCheckDependencies = {
		fetch: fetchMock as unknown as typeof globalThis.fetch,
		imageExists,
		now: () => 1_000,
	};
	return { dependencies, fetchMock, imageExists };
};

describe("custom Dokploy release updates", () => {
	beforeEach(() => {
		clearUpdateDataCache();
		vi.stubEnv("DOKPLOY_UPDATE_IMAGE", "ghcr.io/abhash-chakraborty/dokploy");
		vi.stubEnv("DOKPLOY_RELEASE_REPOSITORY", "Abhash-Chakraborty/dokploy");
		vi.stubEnv("RELEASE_TAG", "latest");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("offers a newer release when its versioned image exists", async () => {
		const { dependencies, imageExists } = createDependencies();

		await expect(getUpdateData("v0.29.11", dependencies)).resolves.toEqual({
			latestVersion: "v0.29.12",
			updateAvailable: true,
		});
		expect(imageExists).toHaveBeenCalledWith(
			"ghcr.io/abhash-chakraborty/dokploy:v0.29.12",
		);
	});

	it("does not offer the installed release", async () => {
		const { dependencies } = createDependencies();
		await expect(getUpdateData("v0.29.12", dependencies)).resolves.toEqual({
			latestVersion: "v0.29.12",
			updateAvailable: false,
		});
	});

	it("does not downgrade an installation newer than the latest release", async () => {
		const { dependencies } = createDependencies();
		await expect(getUpdateData("v0.29.13", dependencies)).resolves.toEqual({
			latestVersion: "v0.29.12",
			updateAvailable: false,
		});
	});

	it("handles a repository with no releases", async () => {
		const { dependencies, imageExists } = createDependencies(
			new Response(null, { status: 404 }),
		);
		await expect(getUpdateData("v0.29.11", dependencies)).resolves.toEqual({
			latestVersion: null,
			updateAvailable: false,
		});
		expect(imageExists).not.toHaveBeenCalled();
	});

	it("ignores draft releases", async () => {
		const { dependencies } = createDependencies(
			releaseResponse({ draft: true }),
		);
		await expect(getUpdateData("v0.29.11", dependencies)).resolves.toEqual({
			latestVersion: null,
			updateAvailable: false,
		});
	});

	it("ignores prereleases on the stable channel", async () => {
		const { dependencies } = createDependencies(
			releaseResponse({ prerelease: true }),
		);
		await expect(getUpdateData("v0.29.11", dependencies)).resolves.toEqual({
			latestVersion: null,
			updateAvailable: false,
		});
	});

	it("waits until the matching versioned image is available", async () => {
		const { dependencies } = createDependencies(releaseResponse(), false);
		await expect(getUpdateData("v0.29.11", dependencies)).resolves.toEqual({
			latestVersion: null,
			updateAvailable: false,
		});
	});

	it("ignores invalid release tags", async () => {
		const { dependencies } = createDependencies(
			releaseResponse({ tag_name: "latest" }),
		);
		await expect(getUpdateData("v0.29.11", dependencies)).resolves.toEqual({
			latestVersion: null,
			updateAvailable: false,
		});
	});

	it("handles GitHub request failures without exposing the error", async () => {
		const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { dependencies } = createDependencies(
			new Error("secret-bearing error"),
		);
		await expect(getUpdateData("v0.29.11", dependencies)).resolves.toEqual({
			latestVersion: null,
			updateAvailable: false,
		});
		expect(warning).toHaveBeenCalledWith(
			"Unable to reach GitHub while checking for Dokploy updates",
		);
		expect(warning).not.toHaveBeenCalledWith(
			expect.stringContaining("secret-bearing"),
		);
	});

	it.each(["canary", "feature"])(
		"does not offer stable releases to the %s channel",
		async (channel) => {
			vi.stubEnv("RELEASE_TAG", channel);
			const { dependencies, fetchMock } = createDependencies();
			await expect(getUpdateData("v0.29.11", dependencies)).resolves.toEqual({
				latestVersion: null,
				updateAvailable: false,
			});
			expect(fetchMock).not.toHaveBeenCalled();
		},
	);

	it("caches verified releases for five minutes", async () => {
		const { dependencies, fetchMock, imageExists } = createDependencies();
		await getUpdateData("v0.29.11", dependencies);
		await getUpdateData("v0.29.11", dependencies);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(imageExists).toHaveBeenCalledTimes(1);
	});

	it("builds a rollback-safe update command for the exact release tag", () => {
		expect(getDokployUpdateArguments("v0.29.12")).toEqual([
			"service",
			"update",
			"--force",
			"--with-registry-auth",
			"--update-failure-action",
			"rollback",
			"--update-monitor",
			"60s",
			"--image",
			"ghcr.io/abhash-chakraborty/dokploy:v0.29.12",
			"dokploy",
		]);
		expect(() => getDokployUpdateArguments("latest")).toThrow(
			"Invalid Dokploy release tag",
		);
	});
});
