/** Keep one byte budget across DSH's legacy and split-limit attachment APIs. */
export function imageTarget(dimensions: { width: number; height: number }, bytes: number) {
  return {
    width: dimensions.width,
    height: dimensions.height,
    maxBytes: bytes,
    maxImageBytes: bytes,
    imageTargetBytes: bytes,
  };
}
