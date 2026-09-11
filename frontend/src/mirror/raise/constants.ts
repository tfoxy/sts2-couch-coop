// THE RAISE/LIFT POLICY'S CONSTANTS — one copy, for both stage backends.
//
// Everything the readable-hand raise, the held-card lift and the tooltip lift key on: the two lift heights, the
// focus ramp's ends, the creature-HUD geometry, and the scene-identity tables that say which node is a hand
// holder, a targeting arrow, a hand-choice prompt or a card tooltip.
//
// WHY IT IS ITS OWN MODULE. The DOM backend (`mirrorRenderer`) and the canvas backend (`canvas/canvasRenderer`)
// share one current policy. A constant a second backend has to copy is a constant that will disagree with itself,
// so it lives here, in a leaf module both import and neither owns.
//
// `mirrorRenderer` re-exports the names it used to declare, so nothing outside this folder had to change.

/**
 * Cosmetic touch-only lift of the held card (`setHeldCard`): a client-side translate COMPOSED with the node's own
 * pose — never sent to the game, so the targeting-arrow tip / drop target stay exactly at the finger. TWO heights,
 * because the two gestures start from a different baseline: a DRAGGED card is NOT focused by the game (it just
 * follows the finger under it), so it needs a big lift to clear the fingertip; a PEEKED card is already focused →
 * enlarged → raised by the game (the peek sends a hover), so a big lift STACKS on top of that and overshoots the
 * card to mid-screen — it only needs a small nudge.
 *
 */
export const HELD_CARD_DRAG_LIFT_PX = 300;
export const HELD_CARD_PEEK_LIFT_PX = 120;
// Hysteresis on the play-zone lift line (design px): once lifted, a dragged card keeps its lift until the finger
// is clearly BELOW the line; once dropped, it re-lifts only on a clean crossing back above. Without the dead-band
// the single-threshold compare flips the whole drag lift at frame rate while the finger sits at the line itself —
// which any residual jitter in the sent Y turns into a card flickering in and out of existence.
export const HELD_LIFT_HYSTERESIS_PX = 40;

// READABLE-HAND MODE (mirrorSettings.raiseHandCards) — the same cosmetic translate mechanism as the held-card lift
// above, applied to the whole resting hand instead of one dragged card. Nothing here reaches the game.
//
// HOW MUCH. At rest the hand's CENTRE card is drawn with its bottom edge 118.8 design px BELOW the 1080 viewport
// floor — which is exactly where a card's rules text sits, so on a phone (no hover) a hand can only be read one
// focused card at a time. Raising every holder by that overhang is what puts the centre card fully on screen; the
// outer cards of the fan are rotated and sit lower, so they stay partly clipped, which is the intended trade (the
// fan's shape must not change, so every card rides the SAME lift).
export const HAND_RAISE_PX = 119;

// FOCUS RAMP. A focused card must keep the game's own pose exactly, and the un-focus must slide from there into the
// raised resting pose without a step. Both fall out of ONE continuous function of the holder's own y in the hand
// container: `t = 0` across the whole resting fan band (every card lifts equally), `t = 1` at the pose the game
// snaps a focused holder to, linear in between — and the applied lift is `HAND_RAISE_PX·(1−t)`. So a focused holder
// lifts by 0 (untouched), and while the game tweens it back down `t` runs 1→0 and the card rises into the raised
// rest pose on the same curve. No threshold, no latch, no focus signal on the wire.
//   START: just above the highest resting fan y (−59), so no card in any hand size is inside the ramp at rest.
//   END:   the game's focused-holder y — its hitbox half-height, less the 2px it keeps on screen.
export const HAND_RAISE_RAMP_START_Y = -65;
export const HAND_RAISE_RAMP_END_Y = -209;

// The hand container / hand root NODE NAMES this pass keys on. A dragged holder is REPARENTED off the container
// onto the hand root by the game, which is both how we know a card is being dragged (see `handDragActive`) and why
// a holder is only raised while it is still a child of the container.
export const HAND_CONTAINER_NAME = "CardHolderContainer";
export const HAND_HOLDER_TYPE = "NHandCardHolder";
export const HAND_ROOT_TYPE = "NPlayerHand";

// CREATURE HUD SHIFT — the other half of readable-hand mode. With the hand raised, a creature's health bar, powers
// and nameplate (the one `creature_state_display` group, drawn BELOW the creature) would sit behind the cards, so
// the whole group moves ABOVE the creature's target reticle, and the intents move up to clear it in turn.
//
// MEASURED PER CREATURE, not a constant. The obvious constant (the authored offsets say the reticle's top edge is
// 179px above the creature origin and the first power row ends 65px below it, i.e. a 244px shift) is only right for
// a creature the size of the authored default: the game RE-PLACES both the selection reticle and the intent row at
// runtime to wrap each creature's actual drawn height, so a big enemy's reticle sits far higher (live: -278 for one
// ally against the authored -179). Both are streamed, so both are read. See `raise/creatureHud.ts`.
export const CREATURE_SCENE_FILE_SUFFIX = "combat/creature.tscn";
export const CREATURE_HUD_NAMES = new Set(["HealthBar", "Intents"]);
// One power's box (`power.tscn` is 48x40 and the container lays them out in rows of that pitch), so the first row
// ends this far below the power container's origin. Reserved whether or not the creature HAS a power yet — the HUD
// must not jump the moment one is applied.
export const CREATURE_POWER_ROW_H = 40;
// The gap the intents keep above the creature's own top box today, preserved above the shifted hp bar instead —
// plus 10px, because the hp bar's NUMBERS overshoot the bar's own box upward and touch the intent row at the
// authored gap (seen live; the bar's layout box does not include its label's ascender).
export const CREATURE_INTENT_GAP = 21;
// Fallbacks for a creature whose reticle/power container hasn't streamed yet — the authored offsets, which give the
// 244/-58 pair the geometry above resolves to for a default-sized creature.
export const CREATURE_RETICLE_TOP_FALLBACK = -179;
export const CREATURE_POWER_TOP_FALLBACK = 25;

// A dragged card's lift releases the instant the game starts TARGETING (an attack card being aimed): the card goes
// static + raised is wrong then — it must sit at rest so the arrow tip reads at the finger. LIVE-VERIFIED: the game
// keeps a hidden `NTargetingArrow` under an always-visible `NTargetManager`; the arrow's own `visible` flips
// false→true exactly while aiming. So "a visible NTargetingArrow exists" IS the targeting signal (NTargetManager is
// always visible, so it can't be used). Using this instead of a distance heuristic also kills the fast-drag "bob"
// (the lift no longer toggles when the finger outruns the lagging card).
export const TARGETING_TYPES = new Set(["NTargetingArrow"]);

// Node-type leaves that host a from-hand card CHOICE (Survivor "Choose a card to Discard", Exhaust / Enchant
// selection). Deliberately EXCLUDES the card GRID selection screen (NCardGridSelectionScreen — deck-view /
// remove-a-card): those cards are not hand cards. Native twin: HandChoiceScan.
export const HAND_CHOICE_TYPES = new Set(["NChooseACardSelectionScreen"]);

// Node NAMES that gate a from-hand card choice but carry no distinctive type leaf. The live in-hand SELECT mode
// (Survivor "Choose a card to Discard" / exhaust / enchant) is view.handSelection on the combat hand — it hosts NO
// NChooseACardSelectionScreen (that leaf is the pick-1-of-N choose-a-card OVERLAY). Its one select-mode-exclusive
// node is the player_hand.tscn backstop named "SelectModeBackstop" (a plain ColorRect → NAME is the signal),
// effectively visible only while an in-hand choice is active. Native twin: HandChoiceScan.
export const HAND_CHOICE_NAMES = new Set(["SelectModeBackstop"]);

// STS2's on-hover card tooltip (producer-probed type `…HoverTips.NHoverTipSet`; contains an NHoverTipCardContainer
// echo). It lives on a separate top-level container, NOT under the card, and its `anchorOwnerId` points at the hand
// holder (NHandCardHolder) — NOT the specific card — so it can't be owner-matched to the held card. But a card
// focus spawns exactly one visible NHoverTipSet (the SETTINGS tooltips are other `N*HoverTip` types), so while a
// card is lifted every visible NHoverTipSet rides the same lift to keep the tip flush with the card.
export const TOOLTIP_TYPE = "NHoverTipSet";
