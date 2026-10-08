import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { UserCog } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/utils/api";

const Schema = z.object({
	port: z.number().int().min(1, "Port must be higher than 0").max(65_535),
	username: z.string().min(1, "Username is required"),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	onSave: () => void;
}

/** SSH user and port the panel uses for this host's terminal. */
const LocalServerConfig = ({ onSave }: Props) => {
	const formId = `local-terminal-settings-${useId().replaceAll(":", "")}`;
	const [open, setOpen] = useState(false);
	const utils = api.useUtils();
	const { data: saved } = api.localTerminal.get.useQuery();
	const { mutateAsync, isPending } = api.localTerminal.save.useMutation();
	const form = useForm<Schema>({
		defaultValues: { port: 22, username: "" },
		resolver: zodResolver(Schema),
	});

	useEffect(() => {
		if (saved) form.reset(saved);
	}, [saved, form]);

	const onSubmit = async (data: Schema) => {
		try {
			await mutateAsync(data);
			await utils.localTerminal.get.invalidate();
			form.reset(data);
			toast.success("Host SSH settings saved");
			setOpen(false);
			onSave();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not save");
		}
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" title="SSH user for this host">
					<UserCog className="size-4" />
					{saved ? `${saved.username} · port ${saved.port}` : "SSH user: auto"}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80">
				<div className="flex flex-col gap-1">
					<span className="text-[13px] font-medium">Host SSH user</span>
					<span className="text-xs text-muted-foreground">
						Found on first connect and shared by every browser. Change it if
						Dokploy's key is authorised for another user.
					</span>
				</div>
				<Form {...form}>
					<form
						id={formId}
						onSubmit={form.handleSubmit(onSubmit)}
						className="grid grid-cols-[1fr_88px] gap-3"
					>
						<FormField
							control={form.control}
							name="username"
							render={({ field }) => (
								<FormItem>
									<FormLabel>User</FormLabel>
									<FormControl>
										<Input placeholder="ubuntu" {...field} />
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
						<FormField
							control={form.control}
							name="port"
							render={({ field }) => (
								<FormItem>
									<FormLabel>Port</FormLabel>
									<FormControl>
										<Input
											{...field}
											type="number"
											min={1}
											max={65_535}
											onChange={(e) => {
												const number = Number.parseInt(e.target.value, 10);
												field.onChange(Number.isNaN(number) ? 1 : number);
											}}
										/>
									</FormControl>
									<FormMessage />
								</FormItem>
							)}
						/>
					</form>
				</Form>
				<Button
					form={formId}
					type="submit"
					className="ml-auto"
					disabled={!form.formState.isDirty}
					isLoading={isPending}
				>
					Save and reconnect
				</Button>
			</PopoverContent>
		</Popover>
	);
};

export default LocalServerConfig;
