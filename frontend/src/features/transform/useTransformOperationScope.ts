import { useCallback, useEffect, useRef } from "react";

// Capture before awaiting; a new token also rejects A -> B -> A completions.
export function useTransformOperationScope(key: string, active = true) {
  const scope = useRef({ key, active });
  if (scope.current.key !== key || scope.current.active !== active) {
    scope.current = { key, active };
  }
  useEffect(() => () => {
    scope.current = { ...scope.current };
  }, []);
  return useCallback(() => {
    const admitted = scope.current;
    return () => admitted.active && scope.current === admitted;
  }, []);
}
