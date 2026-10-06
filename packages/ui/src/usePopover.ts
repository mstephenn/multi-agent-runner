import { useEffect, type RefObject } from "react";

/** While `open`: a pointer press outside `root` or Escape closes it (Escape returns focus to the trigger and is marked handled so global shortcuts skip it). */
export function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement>, trigger: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); close(); trigger.current?.focus(); }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open, close, root, trigger]);
}
