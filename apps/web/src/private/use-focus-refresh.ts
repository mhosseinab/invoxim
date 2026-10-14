import { useEffect, useRef } from "react";

/**
 * Refresh in the foreground on focus/pageshow/visibilitychange.
 * Callers supply a background refresh so an open editor is not discarded.
 */
export function useFocusRefresh(refresh: () => void) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const foreground = () => {
      if (document.visibilityState === "visible") latest.current();
    };
    window.addEventListener("focus", foreground);
    window.addEventListener("pageshow", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("focus", foreground);
      window.removeEventListener("pageshow", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, []);
}
