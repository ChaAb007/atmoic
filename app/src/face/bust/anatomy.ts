/**
 * Landmarks of the procedural bust, in head units: crown to chin is about 1, +y is up and +z faces
 * the viewer. The distance field and the vertex shaders both read these, so the mouth rig always
 * lines up with the sculpted lips.
 */

export const MOUTH = { y: -0.226, z: 0.355, halfWidth: 0.078 } as const;

/** The jaw opens by rotating the lower face about a hinge just in front of the ears. */
export const JAW = { hingeY: -0.03, hingeZ: -0.06, maxAngle: 0.17 } as const;

export const EYE = { x: 0.12, y: 0.035, z: 0.272, radius: 0.06 } as const;

/** The head sways about this point; the neck below it bends progressively. */
export const NECK_PIVOT = { y: -0.5, z: -0.06 } as const;

/** The bust is sculpted down to here; the shaders fade it out a little above. */
export const BUST_BOTTOM_Y = -1.16;

/** Per-point kind, stored as a float attribute so one draw call covers the whole bust. */
export const PointKind = { skin: 0, lip: 1, eyelid: 2, iris: 3 } as const;
