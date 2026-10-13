import * as React from "react";

/** UI-GUIDE §"Below 800px": the collapse rule the shell and this hook share —
 *  pinned to that document by use-mobile.test.ts, so the two cannot drift. */
const MOBILE_BREAKPOINT = 800;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined);

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`);
    const onChange = (): void => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => {
      mql.removeEventListener("change", onChange);
    };
  }, []);

  return isMobile ?? false;
}
