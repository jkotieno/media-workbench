import React from "react";
import { useTranslation } from "react-i18next";

import { api } from "@/lib/api";

type TransformActionLabel = "transform";

const DEFAULT_LABEL: TransformActionLabel = "transform";

export function useTransformActionLabel(imagePath?: string | null) {
  const { t } = useTranslation("gallery");
  const [transformActionLabel, setTransformActionLabel] =
    React.useState<TransformActionLabel>(DEFAULT_LABEL);
  const requestIdRef = React.useRef(0);

  const refreshTransformActionLabel = React.useCallback(
    async (nextImagePath?: string | null): Promise<TransformActionLabel> => {
      const resolvedImagePath =
        (nextImagePath === undefined ? imagePath : nextImagePath)?.trim() || "";
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;

      if (!resolvedImagePath) {
        setTransformActionLabel(DEFAULT_LABEL);
        return DEFAULT_LABEL;
      }

      try {
        const launch = await api.getTransformLaunch(resolvedImagePath);
        if (requestIdRef.current === requestId) {
          setTransformActionLabel(launch.action_label);
        }
        return launch.action_label;
      } catch {
        if (requestIdRef.current === requestId) {
          setTransformActionLabel(DEFAULT_LABEL);
        }
        return DEFAULT_LABEL;
      }
    },
    [imagePath],
  );

  React.useEffect(() => {
    void refreshTransformActionLabel();
  }, [refreshTransformActionLabel]);

  return {
    transformActionLabel:
      transformActionLabel === "transform"
        ? t("viewer.transform")
        : transformActionLabel,
    refreshTransformActionLabel,
  };
}
