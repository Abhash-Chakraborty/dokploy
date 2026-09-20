import { describe, expect, it } from "vitest";
import { repositoryFromDestination } from "@/components/abhash/backups/backup-health";

describe("repositoryFromDestination", () => {
	it("strips the scheme so restic gets a bare host", () => {
		expect(
			repositoryFromDestination({
				endpoint: "https://s3.eu-central-1.amazonaws.com",
				bucket: "my-bucket",
			}),
		).toBe("s3:s3.eu-central-1.amazonaws.com/my-bucket/restic");
	});

	it("accepts an endpoint that already has no scheme", () => {
		expect(
			repositoryFromDestination({
				endpoint: "s3.example.com",
				bucket: "b",
			}),
		).toBe("s3:s3.example.com/b/restic");
	});

	it("does not leave a double slash on a trailing-slash endpoint", () => {
		expect(
			repositoryFromDestination({
				endpoint: "https://account.r2.cloudflarestorage.com/",
				bucket: "dokploy-storage",
			}),
		).toBe("s3:account.r2.cloudflarestorage.com/dokploy-storage/restic");
	});

	it("gives restic its own prefix rather than the bucket root", () => {
		const repo = repositoryFromDestination({
			endpoint: "https://s3.example.com",
			bucket: "shared",
		});
		expect(repo.endsWith("/restic")).toBe(true);
	});
});
