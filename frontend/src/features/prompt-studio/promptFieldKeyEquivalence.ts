type ParsedPromptFieldKey = {
  nodeTokenNormalized: string;
  nodeNumericId: string | null;
  fieldPathNormalized: string;
};

const parsePromptFieldKey = (key: string): ParsedPromptFieldKey | null => {
  if (typeof key !== "string" || !key.includes(".")) return null;

  const [nodeTokenRaw, ...fieldPathParts] = key.split(".");
  const nodeToken = String(nodeTokenRaw || "").trim();
  const fieldPath = fieldPathParts.join(".").trim();
  if (!nodeToken || !fieldPath) return null;

  const nodeNumericId = nodeToken.match(/(\d+)(?!.*\d)/)?.[1] || null;
  return {
    nodeTokenNormalized: nodeToken.split("#")[0].toLowerCase(),
    nodeNumericId,
    fieldPathNormalized: fieldPath.toLowerCase(),
  };
};

export const arePromptFieldKeysEquivalent = (left: string, right: string): boolean => {
  if (left === right) return true;

  const leftParsed = parsePromptFieldKey(left);
  const rightParsed = parsePromptFieldKey(right);
  if (!leftParsed || !rightParsed) return false;
  if (leftParsed.fieldPathNormalized !== rightParsed.fieldPathNormalized) return false;

  if (
    leftParsed.nodeNumericId &&
    rightParsed.nodeNumericId &&
    leftParsed.nodeNumericId !== rightParsed.nodeNumericId
  ) {
    return false;
  }

  if (
    leftParsed.nodeNumericId &&
    rightParsed.nodeNumericId &&
    leftParsed.nodeNumericId === rightParsed.nodeNumericId
  ) {
    return true;
  }

  return leftParsed.nodeTokenNormalized === rightParsed.nodeTokenNormalized;
};

export const findEquivalentPromptFieldKey = (
  targetKey: string,
  candidateKeys: string[]
): string | null => {
  if (candidateKeys.includes(targetKey)) return targetKey;
  return candidateKeys.find((candidate) => arePromptFieldKeysEquivalent(targetKey, candidate)) || null;
};
