import { standardSchemaResolver as zodResolver } from "@hookform/resolvers/standard-schema";
import { Settings } from "lucide-react";
import { useEffect, useId } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import {
	Accordion,
	AccordionContent,
	AccordionItem,
	AccordionTrigger,
} from "@/components/ui/accordion";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Form,
	FormControl,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { api } from "@/utils/api";

const Schema = z.object({
	port: z.number().int().min(1, "Port must be higher than 0").max(65_535),
	username: z.string().min(1, "Username is required"),
});

type Schema = z.infer<typeof Schema>;

interface Props {
	onSave: () => void;
}

const LocalServerConfig = ({ onSave }: Props) => {
	const formId = `local-terminal-settings-${useId().replaceAll(":", "")}`;
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
			onSave();
		} catch (error) {
			toast.error(error instanceof Error ? error.message : "Could not save");
		}
	};

	return (
		<Accordion
			collapsible
			type="single"
			className="rounded-lg bg-muted/20 px-3 bg-muted/40"
		>
			<AccordionItem value="connectionSettings">
				<AccordionTrigger
					className={cn(
						buttonVariants({ variant: "ghost" }),
						"hover:no-underline px-1 mb-2 active:hover:transform-none",
					)}
				>
					<div className="flex flex-row items-center gap-2 justify-between w-full">
						<div className="flex flex-row gap-2 items-center">
							<Settings className="h-4 w-4" />
							<span className="dark:hover:text-white">Host SSH settings</span>
						</div>
					</div>
				</AccordionTrigger>

				<AccordionContent className="px-1 flex flex-col gap-2">
					<Form {...form}>
						<form
							id={formId}
							onSubmit={form.handleSubmit(onSubmit)}
							className="w-full grid grid-cols-2 gap-4"
						>
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
													const value = e.target.value;
													if (value === "") {
														field.onChange(1);
													} else {
														const number = Number.parseInt(value, 10);
														if (!Number.isNaN(number)) {
															field.onChange(number);
														}
													}
												}}
											/>
										</FormControl>

										<FormMessage />
									</FormItem>
								)}
							/>

							<FormField
								control={form.control}
								name="username"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Username</FormLabel>
										<FormControl>
											<Input
												placeholder="Detected on first connect"
												{...field}
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
						Save
					</Button>
				</AccordionContent>
			</AccordionItem>
		</Accordion>
	);
};

export default LocalServerConfig;
