// Depth of field — simplified.
//
// CS2's `r_dof_override` takes FOUR distance planes (world units):
//     near_blurry < near_crisp < [in focus] < far_crisp < far_blurry
// which is how the engine blends, but not how anyone *thinks* about focus.
//
// A camera operator thinks in two numbers: FOCUS DISTANCE (where the subject is
// sharp) and APERTURE / f-stop (how shallow the depth of field is). So we expose
// those two, and compute the four planes from standard depth-of-field optics,
// reusing the focal length we already get from the live FOV (see lens.ts).
//
//   hyperfocal H = f² / (N · c) + f          (f = focal length, N = f-stop, c = CoC)
//   near limit   = H · s / (H + s)           (s = focus distance)
//   far limit    = H · s / (H − s)           (→ infinity once s ≥ H)
//
// We solve the limits twice: once at the "acceptably sharp" circle of confusion
// (gives the crisp planes) and once at a larger CoC (gives the fully-blurred
// planes), so all four planes fall out consistently. Constants are full-frame
// 35mm and easy to retune.

export const COC_MM = 0.029; // circle of confusion, full-frame 35mm
export const BLUR_COC_MULT = 4; // CoC at which a plane reads as "fully blurred"
export const UNITS_PER_MM = 1 / 25.4; // 1 Source unit ≈ 1 inch
export const FAR_CLAMP = 100000; // focus past hyperfocal → far plane is "infinity"

export const F_STOPS = [1.4, 2, 2.8, 4, 5.6, 8, 11, 16];

/** Near/far acceptable-sharpness limits (world units) for a given CoC. */
function limits(focusUnits: number, focalMm: number, fstop: number, cocMm: number) {
  const hyperfocalMm = (focalMm * focalMm) / (fstop * cocMm) + focalMm;
  const H = hyperfocalMm * UNITS_PER_MM; // → world units
  const s = Math.max(focusUnits, 0.001);
  const near = (H * s) / (H + s);
  const far = s >= H ? Infinity : (H * s) / (H - s);
  return { near, far };
}

export type DofPlanes = {
  nearBlurry: number;
  nearCrisp: number;
  farCrisp: number;
  farBlurry: number;
};

/** Focus distance (units) + f-stop + focal length (mm) → the four engine planes. */
export function computeDof(focusUnits: number, fstop: number, focalMm: number): DofPlanes {
  const sharp = limits(focusUnits, focalMm, fstop, COC_MM);
  const blur = limits(focusUnits, focalMm, fstop, COC_MM * BLUR_COC_MULT);
  const clampFar = (v: number) => (isFinite(v) ? Math.max(v, 0) : FAR_CLAMP);
  return {
    nearBlurry: Math.max(clampFar(blur.near), 0),
    nearCrisp: clampFar(sharp.near),
    farCrisp: clampFar(sharp.far),
    farBlurry: clampFar(blur.far),
  };
}
