import copy from "copy-to-clipboard";
import { CopyIcon, ServerIcon } from "lucide-react";
import { toast } from "sonner";
import { PageContainer, PageHeader } from "@/components/shared/page-header";
import { api } from "@/utils/api";
import { ShowDokployActions } from "./servers/actions/show-dokploy-actions";
import { ShowStorageActions } from "./servers/actions/show-storage-actions";
import { ShowTraefikActions } from "./servers/actions/show-traefik-actions";
import { ToggleDockerCleanup } from "./servers/actions/toggle-docker-cleanup";
import { UpdateServer } from "./web-server/update-server";

export const WebServer = () => {
	const { data: webServerSettings } =
		api.settings.getWebServerSettings.useQuery();

	const { data: dokployVersion } = api.settings.getDokployVersion.useQuery();

	return (
		<PageContainer>
			<PageHeader
				title="Web Server"
				description="Reload or clean the web server."
				icon={<ServerIcon className="size-5" />}
			/>
			<div className="space-y-6">
				<div className="grid md:grid-cols-2 gap-4">
					<ShowDokployActions />
					<ShowTraefikActions />
					<ShowStorageActions />

					<UpdateServer />
				</div>

				<div className="flex items-center flex-wrap justify-between gap-4">
					<span className="text-sm text-muted-foreground flex items-center gap-1.5">
						Server IP: {webServerSettings?.serverIp}
						{webServerSettings?.serverIp && (
							<CopyIcon
								className="size-3.5 cursor-pointer hover:text-foreground transition-colors"
								onClick={() => {
									copy(webServerSettings.serverIp ?? "");
									toast.success("Copied to clipboard");
								}}
							/>
						)}
					</span>
					<span className="text-sm text-muted-foreground">
						Version: {dokployVersion}
					</span>

					<ToggleDockerCleanup />
				</div>
			</div>
		</PageContainer>
	);
};
