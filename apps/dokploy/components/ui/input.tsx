import copy from "copy-to-clipboard";
import { Clipboard, EyeIcon, EyeOffIcon, RefreshCcw } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

import { generateRandomPassword } from "@/lib/password-utils";
import { cn } from "@/lib/utils";
import { Button } from "./button";

export interface InputProps extends React.ComponentProps<"input"> {
	errorMessage?: string;
	enablePasswordGenerator?: boolean;
	passwordGeneratorLength?: number;
	enableCopyButton?: boolean;
}

function Input({
	className,
	type,
	errorMessage,
	enablePasswordGenerator = false,
	passwordGeneratorLength,
	enableCopyButton = false,
	ref,
	...props
}: InputProps) {
	const [showPassword, setShowPassword] = React.useState(false);
	const inputRef = React.useRef<HTMLInputElement | null>(null);
	const isPassword = type === "password";
	const shouldShowGenerator =
		isPassword &&
		enablePasswordGenerator !== false &&
		!props.disabled &&
		!props.readOnly;
	const inputType = isPassword ? (showPassword ? "text" : "password") : type;

	const setRefs = React.useCallback(
		(node: HTMLInputElement | null) => {
			inputRef.current = node;
			if (typeof ref === "function") {
				ref(node);
			} else if (ref && typeof ref === "object") {
				(ref as { current: HTMLInputElement | null }).current = node;
			}
		},
		[ref],
	);

	const handleGeneratePassword = () => {
		const nextValue =
			typeof passwordGeneratorLength === "number" && passwordGeneratorLength > 0
				? generateRandomPassword(Math.floor(passwordGeneratorLength))
				: generateRandomPassword();

		const input = inputRef.current;
		if (!input) {
			return;
		}

		const valueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set;
		if (valueSetter) {
			valueSetter.call(input, nextValue);
		} else {
			input.value = nextValue;
		}

		input.dispatchEvent(new Event("input", { bubbles: true }));
	};

	const handleCopy = () => {
		copy(inputRef.current?.value || "");
		toast.success("Value is copied to clipboard");
	};

	const inputElement = (
		<div className="relative w-full">
			<input
				type={inputType}
				data-slot="input"
				className={cn(
					"h-8 w-full min-w-0 rounded-md border border-transparent bg-input px-2.5 py-1 text-[13px] transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-foreground placeholder:text-muted-foreground/80 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-60 read-only:bg-transparent read-only:px-0 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20",
					isPassword && (shouldShowGenerator ? "pr-16" : "pr-10"),
					className,
				)}
				ref={setRefs}
				{...props}
			/>
			{isPassword && (
				<div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-3 text-muted-foreground">
					{shouldShowGenerator && (
						<button
							type="button"
							className="hover:text-foreground focus:outline-none"
							onClick={handleGeneratePassword}
							aria-label="Generate password"
							title="Generate password"
							tabIndex={-1}
						>
							<RefreshCcw className="h-4 w-4" />
						</button>
					)}
					<button
						type="button"
						className="hover:text-foreground focus:outline-none"
						onClick={() => setShowPassword(!showPassword)}
						tabIndex={-1}
					>
						{showPassword ? (
							<EyeOffIcon className="h-4 w-4" />
						) : (
							<EyeIcon className="h-4 w-4" />
						)}
					</button>
				</div>
			)}
		</div>
	);

	return (
		<>
			{enableCopyButton ? (
				<div className="flex w-full items-center space-x-2">
					{inputElement}
					<Button
						type="button"
						variant="ghost"
						size="icon"
						onClick={handleCopy}
						aria-label="Copy"
					>
						<Clipboard className="size-4" />
					</Button>
				</div>
			) : (
				inputElement
			)}
			{errorMessage && (
				<span className="text-xs text-destructive">{errorMessage}</span>
			)}
		</>
	);
}

function NumberInput({ className, ref, ...props }: InputProps) {
	return (
		<Input
			type="text"
			className={cn("text-left", className)}
			ref={ref}
			{...props}
			value={props.value === undefined ? undefined : String(props.value)}
			onChange={(e) => {
				const value = e.target.value;
				if (value === "") {
					props.onChange?.(e);
				} else {
					const number = Number.parseInt(value, 10);
					if (!Number.isNaN(number)) {
						const syntheticEvent = {
							...e,
							target: {
								...e.target,
								value: number,
							},
						};
						props.onChange?.(
							syntheticEvent as unknown as React.ChangeEvent<HTMLInputElement>,
						);
					}
				}
			}}
		/>
	);
}

export { Input, NumberInput };
