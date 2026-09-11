// Shared touch, confirmation, and hit-exclusion policy for both renderer backends.

import type { ConfirmTapKind } from "@/mirror/confirmTap";
import { nodeTypeLeaf, type MirrorNode } from "@/mirror/sceneTree";

// Hover-first TOUCH targets: the interactive widget a touch tap should arm-hover (tap again = click). Keyed by
// Godot node TYPE (the widget root). The root is often BOXLESS (0x0) and its hittable box lives on flat-DOM
// descendants, so we resolve the owning widget at render time and stamp `data-touch-id` (the widget node's id)
// on every descendant. inputCapture then reads that off whatever element a finger lands on. Edit this set as
// new hover-first widgets are confirmed live. (Cards fold into player_hand.tscn but stay type NCard, so one
// type covers hand + shop + deck.)
export const TOUCH_TARGET_TYPES = new Set([
  "NCard",
  "NEventOptionButton",
  "NRestSiteButton",
  "NMerchantRelic",
  "NMerchantPotion",
  // #9: shop carpet CARDS (NMerchantCard — merchant + the fake-merchant EVENT reusing the merchant inventory) and the
  // TREASURE-room relic (NTreasureRoomRelicHolder, whose leaf doesn't end in "Button", so it fell to None → immediate
  // click, no tap-to-focus arm). Confirmed via spirectl static inspection; native twin: TouchTargetScan.TouchTargetTypes.
  "NMerchantCard",
  "NTreasureRoomRelicHolder",
  "NRewardButton",
  // R20: the shop's CARD REMOVAL SERVICE coin — the one thing in the merchant's inventory that did not arm on the
  // first tap. Its leaf is NMerchantCardRemoval (res://scenes/merchant/merchant_card_removal.tscn) with an
  // NClickableControl `Hitbox` child, i.e. the same shape as every other shop slot; but neither its own type nor the
  // hitbox's ends in "Button", so computeTouchInfo classified it as neither a target NOR a block, returned null, and
  // inputCapture's `if (!top)` guard fired BEFORE the tapToFocus check — so the setting was never consulted and one
  // tap was one full click. Exactly the shape NTreasureRoomRelicHolder had before it was listed. Confirmed off the
  // streamed leaf in .sts2/bench/audit-shop-open.ndjson. Native twin: TouchTargetScan.TouchTargetTypes.
  "NMerchantCardRemoval"
]);

// R8: the end-of-event "Proceed" option is displayed through the SAME reusable NEventOptionButton wrapper as a
// regular option (so it isn't statically distinguishable by node type), but keeps the
// res://scenes/ui/proceed_button.tscn (NProceedButton) SCENE IDENTITY — computeSceneInfo reads a node's own
// sceneFilePath before any type check, so this tells the two apart even though both report the "NEventOptionButton"
// type. Matched to a "block" in computeTouchInfo so a tap on it presses IMMEDIATELY (no arm-first double-tap) — the
// desktop click-through already presses it in one action. At least one event screen mounts a proceed button where
// the other options are ordinary option buttons, so the two affordances co-exist on one screen and the scene path
// is the only thing that separates them. Scene-file SUFFIX match (endTurnBoxAt-style; tolerant of a path move).
// Established from the shipped scene files rather than from a live session — re-verify against a live QA
// `dumptypes` capture at an event end-state if higher confidence is required. Native twin:
// TouchTargetScan.ProceedButtonSceneFileSuffix.
export const PROCEED_BUTTON_SCENE_FILE_SUFFIX = "proceed_button.tscn";

// A card grid is used both for harmless browsing (deck / draw / discard) and for a choice the game confirms in its
// own dialog. Only the latter mounts this selection-screen root, so cards beneath an effectively-visible instance
// click immediately instead of consuming a tap merely to focus. Keep the type predicate here, shared by DOM and
// canvas scene identity as well as Confirm tap's modal firewall.
export const CARD_GRID_SELECTION_SCREEN_TYPE = "NCardGridSelectionScreen";

// The remove-a-card flow is a concrete deck selector, rather than the shared card-grid selection base.
// Keep this exact leaf match: its upgrade / transform / enchant / simple-selector cousins retain their own
// arm-first behavior, as does an ordinary NCardGrid used for browsing.
export const DECK_CARD_SELECT_SCREEN_TYPE = "NDeckCardSelectScreen";

// This widget has no specialised runtime leaf: its scene identity is the stable contract. Its ordinary descendants
// (notably the HP label) should arm the whole remote-player state, while an explicit nested control still wins.
export const MULTIPLAYER_PLAYER_STATE_SCENE_FILE = "res://scenes/ui/multiplayer_player_state.tscn";

function ancestorsVisible(nodes: ReadonlyMap<string, MirrorNode>, node: MirrorNode): boolean {
  for (
    let current: MirrorNode | undefined = node;
    current !== undefined;
    current = current.parentId === null ? undefined : nodes.get(current.parentId)
  ) {
    if (!current.visible) return false;
  }
  return true;
}

/** True only while a decision card grid is actually visible, never for a retained hidden screen. */
export function hasEffectivelyVisibleCardGridSelection(nodes: ReadonlyMap<string, MirrorNode>): boolean {
  for (const node of nodes.values()) {
    if (
      nodeTypeLeaf(node.nodeType) === CARD_GRID_SELECTION_SCREEN_TYPE &&
      ancestorsVisible(nodes, node)
    ) {
      return true;
    }
  }
  return false;
}

/** True only while the concrete remove-a-card picker is effectively visible. */
export function hasEffectivelyVisibleDeckCardSelectScreen(nodes: ReadonlyMap<string, MirrorNode>): boolean {
  for (const node of nodes.values()) {
    if (
      nodeTypeLeaf(node.nodeType) === DECK_CARD_SELECT_SCREEN_TYPE &&
      ancestorsVisible(nodes, node)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether a target lives beneath the currently-visible decision-grid screen. */
export function isVisibleCardGridSelectionCard(
  id: string,
  nodes: ReadonlyMap<string, MirrorNode>
): boolean {
  let card: MirrorNode | undefined;
  for (
    let current = nodes.get(id);
    current !== undefined;
    current = current.parentId === null ? undefined : nodes.get(current.parentId)
  ) {
    if (nodeTypeLeaf(current.nodeType) === "NCard") card = current;
    if (nodeTypeLeaf(current.nodeType) === CARD_GRID_SELECTION_SCREEN_TYPE) {
      return card !== undefined && ancestorsVisible(nodes, card) && ancestorsVisible(nodes, current);
    }
  }
  return false;
}

/** Whether a card belongs to the exact, effectively-visible remove-a-card picker. */
export function isVisibleDeckCardSelectCard(
  id: string,
  nodes: ReadonlyMap<string, MirrorNode>
): boolean {
  let card: MirrorNode | undefined;
  for (
    let current = nodes.get(id);
    current !== undefined;
    current = current.parentId === null ? undefined : nodes.get(current.parentId)
  ) {
    if (nodeTypeLeaf(current.nodeType) === "NCard") card = current;
    if (nodeTypeLeaf(current.nodeType) === DECK_CARD_SELECT_SCREEN_TYPE) {
      return card !== undefined && ancestorsVisible(nodes, card) && ancestorsVisible(nodes, current);
    }
  }
  return false;
}

export function isMultiplayerPlayerStateSceneRoot(node: Pick<MirrorNode, "sceneFilePath">): boolean {
  return node.sceneFilePath === MULTIPLAYER_PLAYER_STATE_SCENE_FILE;
}

// R19: what counts as a CARD for the gesture machine's card semantics (`isCardTouchTarget`) — the predicate that,
// with `isHandCard`, splits a touch target into `handCard` (peek / drag-lift / tap-unselect) and `nonHandCard` (the
// long-press right-click that opens the item's detail dialog). It used to be the single leaf "NCard", which is why a
// sustained touch on a SHOP card did nothing: a shop item's touch target resolves to NMerchantCard / NMerchantRelic /
// NMerchantPotion, so BOTH halves were false and the long-press deadline was never armed. Every entry here is already
// a TOUCH_TARGET_TYPES member (it has to be — the target must resolve before this is asked), and none of them can be
// a HAND card, so widening this set only ever adds the non-hand long-press leg.
// DELIBERATELY EXCLUDED: NRewardButton and NTreasureRoomRelicHolder. Both live on screens where the gesture consumes a
// real run reward, which is not where a new touch verb gets its first outing. R20 adds NMerchantCardRemoval to that
// list for a different reason: this set drives the non-hand long-press RIGHT-CLICK, whose whole job is to open an
// item's DETAIL dialog — and the removal coin is a service, not an item, so it has no detail view for a right-click
// to open. GestureMachineTests.LongPressNonCardTargetNoRightClick already pins that shape.
// Kill switch: the existing `?longpressRclick=off` / native LONGPRESS_RCLICK, which gates the whole non-hand leg.
// Native twin (keep in lockstep — the two clients run the same decision tree): TouchTargetScan.CardTouchTargetTypes.
export const CARD_TOUCH_TARGET_TYPES = new Set(["NCard", "NMerchantCard", "NMerchantRelic", "NMerchantPotion"]);

// CONFIRM TAP (see confirmTap.ts) — the touch targets whose tap CONSUMES a run reward, so the two-step tap's
// second tap must not be the thing that commits them. Every entry is already a TOUCH_TARGET_TYPES member (the
// target has to resolve before this is asked). The three types that need more than their leaf are handled in
// confirmTapEligible below.
//
// The SHOP set is the whole merchant inventory (relic / potion / card / the card-removal service coin), because
// every one of them spends gold. That includes the Fake Merchant event: its NFakeMerchantInventory reuses the
// normal NMerchantRelic / NMerchantPotion / NMerchantCard widgets, so it deliberately takes this same path rather
// than growing an event-specific input rule. Rest-site choices are here too: picking rest-vs-upgrade ends the room.
// DELIBERATELY ABSENT: hand cards (a mis-played card is recoverable and the play gesture is a drag, not a tap),
// deck / card-grid dialog cards (a browse, not a commitment), and NRewardButton (the post-combat reward LIST rows
// open their reward's own screen — the pick inside it is what this guards).
const CONFIRM_TAP_TARGET_KINDS = new Map<string, ConfirmTapKind>([
  ["NCard", "reward"], // gated: reward-screen cards only, see confirmTapEligible
  ["NEventOptionButton", "event"],
  ["NRestSiteButton", "rest"],
  ["NMerchantRelic", "shop"],
  ["NMerchantPotion", "shop"],
  ["NMerchantCard", "shop"],
  ["NMerchantCardRemoval", "shop"],
  ["NTreasureRoomRelicHolder", "relic"] // gated: multiplayer holders only, see confirmTapEligible
]);

// The screen an NCard has to live under to be a REWARD pick rather than a hand / deck / grid card. Matched as a
// scene-file SUFFIX (tolerant of a path move), the endTurnBoxAt / PROCEED_BUTTON_SCENE_FILE_SUFFIX idiom.
const CARD_REWARD_SCENE_FILE_SUFFIX = "card_reward_selection_screen.tscn";

// The treasure room's SINGLEPLAYER relic holder (rooms/treasure_room.tscn instances five holders: this one and
// MultiplayerRelicHolder1..4). Excluded by user decision: a singleplayer chest offers ONE relic and can be skipped,
// and the Skip button occupies the same bottom-right corner as the confirm button would.
const SINGLEPLAYER_RELIC_HOLDER_NAME = "SingleplayerRelicHolder";

// The merchant's card-REMOVAL service is the one inventory slot that stays on the carpet after it is used (every
// other item is removed from the tree when bought, which the button's own liveness check already handles). A spent
// service is not a choice, so it must not raise a confirm button. THE SIGNAL is its `Cost` child going invisible —
// live-verified by A/B against two shop recordings where the service is still available (`Cost` visible in both)
// and a live shop where it had been used (`Cost` and its `CostLabel` both `visible: false`, everything else in the
// widget byte-identical). Name-matched on the slot's own direct child.
const MERCHANT_COST_CHILD_NAME = "Cost";

/**
 * Which irreversible-choice kind a touch-target widget is, or null when its tap is not one. Pure (the two ancestor
 * questions are injected) so the table above is unit-testable without a renderer. See CONFIRM_TAP_TARGET_KINDS for
 * the set and the two gated cases.
 */
export function confirmTapEligible(
  node: Pick<MirrorNode, "id" | "name" | "nodeType"> | null | undefined,
  isHandCard: (id: string) => boolean,
  hasAncestorSceneFile: (id: string, suffix: string) => boolean,
  hasVisibleChild: (id: string, name: string) => boolean = () => true
): ConfirmTapKind | null {
  if (!node) {
    return null;
  }
  const leaf = nodeTypeLeaf(node.nodeType);
  const kind = CONFIRM_TAP_TARGET_KINDS.get(leaf);
  if (kind === undefined) {
    return null;
  }
  if (leaf === "NCard") {
    return !isHandCard(node.id) && hasAncestorSceneFile(node.id, CARD_REWARD_SCENE_FILE_SUFFIX) ? kind : null;
  }
  if (leaf === "NTreasureRoomRelicHolder") {
    return node.name === SINGLEPLAYER_RELIC_HOLDER_NAME ? null : kind;
  }
  if (leaf === "NMerchantCardRemoval") {
    return hasVisibleChild(node.id, MERCHANT_COST_CHILD_NAME) ? kind : null;
  }
  return kind;
}

// HAND-card ancestor types. Only a card under one of these gets the peek / drag-lift / unselect card semantics; a
// deck-dialog / reward NCard has no such ancestor and is treated as a plain node (a tap falls through to the game's
// native left-click). Verified live combat ancestry: NCard → NHandCardHolder → CardHolderContainer → NPlayerHand.
// Node NAMES are anonymous live (no CARD_* prefixes), so this matches by node TYPE only. Native twin:
// TouchTargetScan.HandCardAncestorTypes.
export const HAND_CARD_ANCESTOR_TYPES = new Set(["NHandCardHolder", "NPlayerHand"]);

const COMBAT_PILE_CONTAINER_TYPE = "NCombatPilesContainer";
const COMBAT_PILE_CONTAINER_SCENE_SUFFIX = "/combat_piles_container.tscn";

/** Stable identity for the combat-HUD layer that owns CouchCoop's hand control. */
export function isCombatPileContainer(node: Pick<MirrorNode, "nodeType" | "sceneFilePath">): boolean {
  return (
    nodeTypeLeaf(node.nodeType) === COMBAT_PILE_CONTAINER_TYPE ||
    node.sceneFilePath?.endsWith(COMBAT_PILE_CONTAINER_SCENE_SUFFIX) === true
  );
}

// #12: the from-hand card-CHOICE identities (Survivor "Choose a card to Discard", Exhaust / Enchant selection).
// While one is effectively visible a tap on a HAND card selects with a SINGLE tap (no arm-first) and the below-line
// unselect right-click is suppressed. They moved to `@/mirror/raise/constants` — the raise stands aside for the
// same prompt — and are re-exported here for the touch rules that also key on them.
export { HAND_CHOICE_NAMES, HAND_CHOICE_TYPES } from "@/mirror/raise/constants";

// R11 WS-M: the ARMED map-drawing-tool textures. The map screen's DrawButton / EraseButton swap their Icon's
// texture to the `*_glow` variant exactly while that tool is armed (captured live in
// `.sts2/bench/final-smoke-mapstroke.ndjson`, deltas 17-27), and back when it is put away — so this, not
// selfModulate (which also brightens on plain hover), is the reliable armed signal. Matched as a URL SUFFIX
// because textureUrl is the host asset route (`/res/images/packed/map/drawing_quill_glow.png`).
export const DRAWING_TOOL_ARMED_TEXTURES = ["drawing_quill_glow.png", "drawing_eraser_glow.png"];

// The leaf (final dotted segment) of a Godot type name — moved to `sceneTree` (next to the wire node it reads) so
// a policy module can key on a node type without importing this backend. Re-exported: it is called from a dozen
// places here and from every module that imports it off this one.
export { nodeTypeLeaf };

// A non-hover-first interactive control (a plain button) should be an IMMEDIATE touch click AND must BLOCK the
// hit-test from falling through to a hover-first widget behind it (e.g. the card-reward "Skip" button sits over
// the reward cards — without this, a tap on Skip would resolve to a card and arm a hover). We mark such buttons
// with `data-touch-block` so the scan stops. Heuristic: any node type ending in "Button" that isn't itself a
// hover-first target (those are matched first). Its root is also often boxless, so we stamp descendants too.
export function isBlockingButtonType(nodeType: string): boolean {
  return nodeTypeLeaf(nodeType).endsWith("Button");
}

// R11 WS-S §4 — a card grid's SCROLLBAR is a blocking control too, and it is the one control in the mirror that
// takes an ABSOLUTE input channel: the bar consumes the press itself (the grid behind it never sees it), and the
// grid's scroll target then follows the BAR's position as a FRACTION of the full scroll range. Press = jump to a
// fraction, drag = keep jumping — nothing relative, nothing an eager offset can lead. Marking the whole strip a
// touch block is what
// tells the input side "this press is spoken for": no phantom pan, no tap arming, and (without the client's own
// absolute channel) the press/drag/release pass straight through to the host, whose jump-to-fraction is then
// mirrored back as ordinary streamed motion. WHICH of the two spoke for it is the block's kind — see below.
const SCROLLBAR_BLOCK_TYPES = new Set(["NScrollbar", "NScrollbarTrain", "NDropdownScrollbar"]);
export function isScrollbarBlockType(nodeType: string): boolean {
  return SCROLLBAR_BLOCK_TYPES.has(nodeTypeLeaf(nodeType));
}

// WHICH block a `data-touch-block` element is. All three stop the hit-test scan exactly as they always did — the
// value only tells the input side WHAT stopped it, which is a question the eager-scroll bar claim has to be able to
// ask and, until now, could not:
//   "1"      a plain button (the historical stamp, unchanged);
//   "bar"    a scrollbar's TRACK — the strip the client's absolute claim may take;
//   "thumb"  the bar's HANDLE (`NScrollbarTrain`), the one part of the strip a player grabs on purpose.
// The track/thumb split is what lets a FINGER drag be read as intent: a press on the thumb is a grab, a press on
// the track is not (see eagerScroll's deferred track gesture), while a press on ANY of them under a button is the
// button's (see the occlusion gate). Nothing outside inputCapture reads the value — every other consumer tests the
// attribute's PRESENCE.
export type TouchBlockKind = "button" | "bar" | "thumb";
const SCROLLBAR_HANDLE_TYPE = "NScrollbarTrain";
export const TOUCH_BLOCK_ATTR: Record<TouchBlockKind, string> = { button: "1", bar: "bar", thumb: "thumb" };

export function scrollbarBlockKind(nodeType: string): TouchBlockKind {
  return nodeTypeLeaf(nodeType) === SCROLLBAR_HANDLE_TYPE ? "thumb" : "bar";
}

// A hover-first widget's OVERSIZED DECORATIVE OVERLAYS — an event option's RedFlash/BlueFlash (drawn ~5× the
// button height), a card's Highlight/Glow/Vfx — are flat-DOM descendants that carry the widget's id but extend
// FAR beyond its interactive area, so a hovered/enlarged widget's overlay covers its neighbours and steals their
// taps (the flaky "switching cards fires a click"). These are CanvasItem nodes WITHOUT a Godot Control type
// (Node2D-family, manual hit-handling), so they have no `mouse_filter` for the producer to mark
// pointer-events:none. We instead refuse to stamp them with the widget's `data-touch-id` (matched by node NAME
// or TYPE — the decorative-effect convention), so they never participate in touch identity; the widget's real
// content (Image/Text/the button row) still carries the id and stays tappable.
const DECORATIVE_OVERLAY = /flash|glow|highlight|vfx|sparkle|shine|halo/i;

// ---------------------------------------------------------------------------------------------------------------
// THE NAME/TYPE PREDICATE MEMO — one WeakMap, computed once per node OBJECT.
//
// WHY (Aug-28 Moto G86 combat trace). `buildHitEntry` runs for every hit-eligible node on every build, and these
// predicates are what it spends its time in: `isHitTestExcluded` was 3.9% of frame SELF time and
// `isDecorativeOverlay` 2.4% — ~6.3% of the frame, i.e. ~0.7 ms of an ~11.5 ms budget, spent re-running two
// regexes and two Set lookups over strings that had not changed since the last frame. `nodeTypeLeaf` was already
// memoized for exactly this reason (see sceneTree); this finishes the job at the predicate level.
//
// WHY A WeakMap AND NOT A STRING KEY. The obvious cache is `Map<name + nodeType, bits>`, and it leaks: one 30 s
// combat recording carries 1,527 distinct node NAMES (987 of them with an embedded instance id) against only 198
// distinct node TYPES, so a name-keyed map grows without bound for the length of a run. On the device whose
// memory pressure caused this round's headline bug, an unbounded cache is precisely the wrong thing to add.
//
// Node identity is the right key instead, and it is SELF-INVALIDATING. `sceneTree.mergeNode` never mutates a node
// in place — it returns a fresh object for every upsert — so a node whose fields could have changed is a cache
// MISS by construction, and a WeakMap's entries die with the nodes. There is no invalidation hook to forget to
// call. (Measured on the same recording: ~13 upserts per message against a scene of well over a thousand nodes,
// so the miss rate is around 1%.)
//
// `mergeNode` also carries `name` and `nodeType` FORWARD from the retained node on a volatile-only upsert, so the
// recompute a miss pays for lands on the same answer. That is a correctness note, not an optimisation: it is why
// a fresh object is safe to treat as "unknown" rather than as "changed".
// A frozen object rather than a `const enum` ON PURPOSE. The offline draw-list builder the text gates run on
// (the text-crop path through `buildDrawList.ts` -> here) is loaded by Node's type-stripping loader, which
// erases annotations without ever type-checking; a `const enum` has no erasure — its members only exist after a
// real compile — so it is a hard `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` there. This shape emits the same three
// numeric constants under both loaders, so the gate keeps working. Anything the offline builder can reach must
// stay erasable.
const NodeBits = {
  Decorative: 1,
  Echo: 2,
  RemoteFollower: 4
} as const;
const nodePredicateMemo = new WeakMap<MirrorNode, number>();

function nodeBits(node: MirrorNode): number {
  let bits = nodePredicateMemo.get(node);
  if (bits === undefined) {
    const leaf = nodeTypeLeaf(node.nodeType);
    bits =
      (DECORATIVE_OVERLAY.test(node.name) || DECORATIVE_OVERLAY.test(leaf) ? NodeBits.Decorative : 0) |
      (ECHO_CONTAINER.test(leaf) ? NodeBits.Echo : 0) |
      (REMOTE_FOLLOWER_TYPES.has(leaf) ? NodeBits.RemoteFollower : 0);
    nodePredicateMemo.set(node, bits);
  }
  return bits;
}

export function isDecorativeOverlay(node: MirrorNode): boolean {
  return (nodeBits(node) & NodeBits.Decorative) !== 0;
}

// Non-interactive ECHO containers that re-render a card on TOP of the real one: hover previews
// (NCardPreviewContainer / NGridCardPreviewContainer / NMessyCardPreviewContainer), hover-tip cards
// (NHoverTipCardContainer), and the inspect/zoom popup (NInspectCardScreen). Their inner NCard is itself a
// TOUCH_TARGET, so without this it would carry a `data-touch-id` and steal taps meant for the real card beneath
// (the residual flaky false-commit). Verified live: the SELECTABLE cards live under NCardGrid/NGridCardHolder
// (no match here), so this never disables a real card. Matched by node TYPE (the container's class name).
const ECHO_CONTAINER = /Preview|HoverTip|Inspect/;

export function isEchoContainer(node: MirrorNode): boolean {
  return (nodeBits(node) & NodeBits.Echo) !== 0;
}

// REMOTE followers ride a TEAMMATE's game cursor — a shift THIS client never resolved. Placed at the shift of
// whatever visibly-painting mouse-visible control sits under their true game point (hitTestShift), so they anchor to the
// same re-laid-out content the remote player is pointing at. (A LOCAL follower — this client's own grabbed
// targeting arrow / cursor VFX — needs NO special-casing: the game draws its segments at the game cursor and the
// per-entity positional field maps them through the same map the input inverse uses, so they land under the finger.)
//
// LIVE-VERIFY: these leaf names are still UNVERIFIED against the streamed `nodeType` strings — confirm them
// against a live capture before relying on this set.
export const REMOTE_FOLLOWER_TYPES = new Set(["NRemoteMouseCursor", "NRemoteTargetingIndicator"]);

export function isRemoteFollower(node: MirrorNode): boolean {
  return (nodeBits(node) & NodeBits.RemoteFollower) !== 0;
}

// A node that must NEVER serve as a hit-test ANCHOR for a remote follower: a follower itself (a cursor can't
// anchor to itself or to another cursor), an ECHO card (a preview/inspect copy that isn't the real board), or an
// owner-anchored floater (a tooltip that already tracks its owner) — anchoring to any of these would feed back a
// self-referential or transient shift. Checked on the node itself (its follower subtree's descendants are
// Node2D-family with no Stop mouse_filter, so they're already skipped by the Stop gate in hitTestShift).
export function isHitTestExcluded(node: MirrorNode): boolean {
  // One memo read covers both type predicates; `anchorOwnerId` is a per-node field and is read directly.
  return (nodeBits(node) & (NodeBits.RemoteFollower | NodeBits.Echo)) !== 0 || node.anchorOwnerId != null;
}

// AURA layers that must never anchor the pointer's visual map (`data-paints` is withheld; they still RENDER):
// state/cursor feedback textures whose BOX wildly exceeds their entity's visible art and overhangs OTHER frames'
// content. elementsFromPoint can't see their transparent pixels, so as topmost painters they hijack pointers aimed
// at content beneath: the hand cards' always-on cyan glow (NCardHighlight, a 607px box on a 240px card — ~3 card
// slots wide) floats over the world band where creature healthbars live, and its exact inverse (the CARD's frame)
// made the creature POWER icons (a different frame) unhoverable except in an offset band. `Flash` is the card's
// draw/play flash overlay — same shape, matched by NAME (it's a plain TextureRect).
//
// LIVE-VERIFY: NCardHighlight confirmed against the streamed nodeType; extend this set if another aura class
// starts hijacking hovers (symptom: hover hotspot horizontally offset from the visual by (auraDx − targetDx)).
export const PAINT_ANCHOR_EXCLUDED_TYPES = new Set(["NCardHighlight"]);
export const PAINT_ANCHOR_EXCLUDED_NAMES = new Set(["Flash"]);

export function isPaintAnchorExcluded(node: MirrorNode): boolean {
  return PAINT_ANCHOR_EXCLUDED_TYPES.has(nodeTypeLeaf(node.nodeType)) || PAINT_ANCHOR_EXCLUDED_NAMES.has(node.name);
}
