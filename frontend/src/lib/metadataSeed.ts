type ParamMap = Record<string, unknown> | null | undefined;

const isParamMap = (value: ParamMap): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object");

const isSeedKey = (key: string): boolean => {
  const normalized = key.trim().toLowerCase();
  return (
    normalized === "seed" ||
    normalized === "noise_seed" ||
    normalized.endsWith(".seed") ||
    normalized.endsWith(".noise_seed")
  );
};

export const isRandomSeedPlaceholder = (value: unknown): boolean => {
  if (typeof value === "number") return value === -1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "-1" || normalized === "random" || normalized === "randomize" || normalized === "rand";
  }
  return false;
};

const resolveSeedCandidate = (params: ParamMap): string | number | undefined => {
  if (!isParamMap(params)) return undefined;
  for (const key of ["seed", "noise_seed"]) {
    const value = params[key];
    if ((typeof value === "number" || typeof value === "string") && !isRandomSeedPlaceholder(value)) {
      return value;
    }
  }
  for (const [key, value] of Object.entries(params)) {
    if (!isSeedKey(key)) continue;
    if ((typeof value === "number" || typeof value === "string") && !isRandomSeedPlaceholder(value)) {
      return value;
    }
  }
  return undefined;
};

export const hasResolvedSeedValue = (...sources: ParamMap[]): boolean =>
  sources.some((params) => resolveSeedCandidate(params) !== undefined);

export const mergeJobParamsWithResolvedSeed = (...sources: ParamMap[]): Record<string, unknown> => {
  const normalizedSources = sources.filter(isParamMap);
  const merged = Object.assign({}, ...normalizedSources);
  const resolvedSeed = normalizedSources
    .slice()
    .reverse()
    .map((params) => resolveSeedCandidate(params))
    .find((value) => value !== undefined);

  if (resolvedSeed !== undefined) {
    Object.entries(merged).forEach(([key, value]) => {
      if (isSeedKey(key) && isRandomSeedPlaceholder(value)) {
        merged[key] = resolvedSeed;
      }
    });
    if (merged.seed === undefined || isRandomSeedPlaceholder(merged.seed)) {
      merged.seed = resolvedSeed;
    }
    if ("noise_seed" in merged && isRandomSeedPlaceholder(merged.noise_seed)) {
      merged.noise_seed = resolvedSeed;
    }
  }

  return merged;
};
