// Every tuning number of the core gameplay in one place (Tangled Rope spec §12). Units:
// 1 unit = one slot (70 px of level data); slots are STEP apart (92 px); s = seconds.
// Where this game departs from the spec, or a value had to be guessed, it says so.

export const CFG = {
  // grid
  STEP: 1.3143,                 // slot to slot (rows); columns may be spread wider so the board fills the screen width (this game)
  SLOT: 1,                      // slot size
  // handle (pin)
  distanceFromFinger: 0.7,      // a carried pin floats this far above the finger (towards the top of the screen)
  operateScale: 1.15, operateScaleTime: 0.2,
  operateColliderScaleUpInterval: 0.3,   // a pin just put down can't be picked again for this long
  pushAwayDistance: 0.62,       // picking a pin pushes other ropes' beads this far from it (spec: per prefab — guessed)
  needMoveMinDistance: 0.01,
  maxMoveSpeedXY: 30, maxMoveSpeedZ: 5, maxSnapMoveSpeedZ: 6,
  liftZ: 0.85,                  // how high a carried pin floats (spec: "one z level" — guessed)
  slotActiveDistance: 1.0,
  recoverStopStressInterval: 1.0,
  // rope
  extraRopeLengthForGenerate: 20 / 70,   // physical rope = Length + this
  extraRopeLengthForOperate: 20 / 70,    // looser snap limit while the pin is inside its reach
  warningRate: 1.25, snapRate: 1.35,
  warningColor: '#F58F38', snapColor: '#FF2E2E',
  notOverlapIntervalBeforeDisappear: 0.3,
  particleDistance: 0.2,        // two groups whose beads come this close seen from above overlap (spec: per prefab — guessed)
  // group disappearing
  disappearScale: 1.1, disappearScaleUp: 0.1, disappearScaleDown: 0.1, disappearMoveInterval: 0.3, disappearZ: 0.5,
  // boosters
  hammerRange: 2.0, hammerMinImpact: 2.5, hammerMaxImpact: 4,   // spec 12–19 is in Obi's units; scaled to this physics (guessed)
  shakeDuration: 0.2,
  expansionCameraAdjustInterval: 0.3,
  // timing
  fixedDeltaTime: 1 / 60,
  delayInvokeGameFinishEventTime: 0.5,
  // colours of a converted pin by moves left (1..4)
  convertedColors: ['#E8343B', '#E6C13A', '#3D8DF2', '#7BD36A'],
} as const;

/** Booster unlock levels (1-based). SnowFlake is left out: this game has no clock. */
export const BOOSTER_UNLOCK = { scissors: 5, hammer: 9, expand: 11 } as const;
