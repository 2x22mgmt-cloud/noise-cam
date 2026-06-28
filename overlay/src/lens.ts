// FOV <-> focal length.
//
// CS2 / Source report a HORIZONTAL field of view in degrees. Filmmakers think in
// focal length (mm), so we map FOV to a 35mm full-frame equivalent using the
// standard horizontal film-back width of 36mm:
//
//     focal = (filmback / 2) / tan(fov / 2)
//     fov   = 2 * atan((filmback / 2) / focal)
//
// Sanity: 90° -> 18mm, ~74° -> 24mm, ~54° -> 35mm, ~40° -> 50mm, ~24° -> 85mm.
// FILM_BACK is a constant so it's easy to retune if we ever prefer a different
// reference (e.g. a 24mm vertical or Super35 back).

export const FILM_BACK_MM = 36;
const DEG = Math.PI / 180;

/** Horizontal FOV in degrees -> focal length in mm (full-frame equivalent). */
export function fovToFocal(fovDeg?: number): number | undefined {
  if (typeof fovDeg !== "number" || !isFinite(fovDeg) || fovDeg <= 0 || fovDeg >= 179) {
    return undefined;
  }
  return FILM_BACK_MM / 2 / Math.tan((fovDeg * DEG) / 2);
}

/** Focal length in mm -> horizontal FOV in degrees. */
export function focalToFov(mm: number): number {
  return (2 * Math.atan(FILM_BACK_MM / 2 / mm)) / DEG;
}

/** Pretty focal length, e.g. "24mm" (or "–" when unknown). */
export function fmtFocal(fovDeg?: number, digits = 0): string {
  const mm = fovToFocal(fovDeg);
  return mm === undefined ? "–" : `${mm.toFixed(digits)}mm`;
}
