// The mod's own item-meta group names (C# RenderStreamItemTagger). A module's `wants.groups` must list exactly the
// groups it reads; the seat grants groups whole, so only these names ever leave the host. One copy on each side,
// kept in lockstep by the C# runner's item-tagger test and the vitest spec that asserts this list.

export const RS_GROUP_HAND_HOLDER = "couchcoop_rs_hand_holder";
export const RS_GROUP_HAND_ROOT = "couchcoop_rs_hand_root";
export const RS_GROUP_HAND_CONTAINER = "couchcoop_rs_hand_container";
export const RS_GROUP_TARGETING_ARROW = "couchcoop_rs_targeting_arrow";
export const RS_GROUP_HAND_CHOICE = "couchcoop_rs_hand_choice";
export const RS_GROUP_CREATURE_HUD = "couchcoop_rs_creature_hud";
export const RS_GROUP_CREATURE_RETICLE = "couchcoop_rs_creature_reticle";
export const RS_GROUP_CREATURE_POWER = "couchcoop_rs_creature_power";
export const RS_GROUP_CARD_REWARD_ROOT = "couchcoop_rs_card_reward_root";
export const RS_GROUP_CARD_REWARD_CARD = "couchcoop_rs_card_reward_card";
export const RS_GROUP_TREASURE_RELIC = "couchcoop_rs_treasure_relic";
// CONFIRM TAP (the stream's input-side confirm feature): the three confirm-eligible families the handoff asked to
// tag in RenderStreamItemTagger (reward and treasure reuse the TAG3 groups above).
export const RS_GROUP_EVENT_OPTION = "couchcoop_rs_event_option";
export const RS_GROUP_SHOP_ITEM = "couchcoop_rs_shop_item";
export const RS_GROUP_REST_SITE = "couchcoop_rs_rest_site";

/** The groups the raised-hand module reads. */
export const RAISE_GROUPS = [
  RS_GROUP_HAND_HOLDER,
  RS_GROUP_HAND_ROOT,
  RS_GROUP_HAND_CONTAINER,
  RS_GROUP_TARGETING_ARROW,
  RS_GROUP_HAND_CHOICE,
  RS_GROUP_CREATURE_HUD,
  RS_GROUP_CREATURE_RETICLE,
  RS_GROUP_CREATURE_POWER
] as const;

/** The groups the view-scale module reads. */
export const VIEW_SCALE_GROUPS = [
  RS_GROUP_CARD_REWARD_ROOT,
  RS_GROUP_CARD_REWARD_CARD,
  RS_GROUP_TREASURE_RELIC
] as const;

/** The groups the held-card (raiseHeldCard / unfocusOnRelease) module reads. */
export const HELD_CARD_GROUPS = [
  RS_GROUP_HAND_HOLDER,
  RS_GROUP_TARGETING_ARROW
] as const;

/** The groups the confirm-tap module reads. */
export const CONFIRM_TAP_GROUPS = [
  RS_GROUP_CARD_REWARD_CARD,
  RS_GROUP_TREASURE_RELIC,
  RS_GROUP_EVENT_OPTION,
  RS_GROUP_SHOP_ITEM,
  RS_GROUP_REST_SITE
] as const;
