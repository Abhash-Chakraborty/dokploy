import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useState,
} from "react";
import { createPortal } from "react-dom";

type HeaderSlotState = {
	target: HTMLElement | null;
	claim: () => () => void;
};

const HeaderSlotContext = createContext<HeaderSlotState | null>(null);

/**
 * Lets a page put its own breadcrumb into the shared top bar, so every page
 * keeps the same bar height and the sidebar toggle never moves.
 */
export const useHeaderSlotHost = () => {
	const [target, setTarget] = useState<HTMLElement | null>(null);
	const [claims, setClaims] = useState(0);
	const value: HeaderSlotState = {
		target,
		claim: () => {
			setClaims((count) => count + 1);
			return () => setClaims((count) => count - 1);
		},
	};
	return { value, setTarget, claimed: claims > 0 };
};

export const HeaderSlotProvider = HeaderSlotContext.Provider;

export const HeaderSlot = ({ children }: { children: ReactNode }) => {
	const slot = useContext(HeaderSlotContext);
	const claim = slot?.claim;
	// One claim per mount: claim is a new function on every render.
	useEffect(() => claim?.(), []);
	if (!slot?.target) return null;
	return createPortal(children, slot.target);
};
