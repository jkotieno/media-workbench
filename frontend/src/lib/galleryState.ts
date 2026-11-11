export type GalleryScrollPosition = {
  scrollTop: number;
  anchorKey?: string;
  anchorOffset?: number;
  anchorIndex?: number;
  nextAnchorKey?: string;
  previousAnchorKey?: string;
  /** Requested extent owned by the paged project-gallery browser. */
  mediaPageCount?: number;
};

const scrollPositions = new Map<string, GalleryScrollPosition>();

export const getScrollSnapshot = (key: string): GalleryScrollPosition =>
  scrollPositions.get(key) ?? { scrollTop: 0 };

export const getScrollPosition = (key: string): number =>
  getScrollSnapshot(key).scrollTop;

export const saveScrollSnapshot = (
  key: string,
  position: GalleryScrollPosition,
): void => {
  scrollPositions.set(key, position);
};

export const saveScrollPosition = (key: string, scrollTop: number): void => {
  saveScrollSnapshot(key, { scrollTop });
};
