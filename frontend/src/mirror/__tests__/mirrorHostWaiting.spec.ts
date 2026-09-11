import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import MirrorHostWaiting from "@/mirror/MirrorHostWaiting.vue";

// F3 — the screen a `?name=<seat>` viewer sees while the host is somewhere with no seat to give (main menu,
// singleplayer character select, singleplayer run). The COPY is asserted verbatim: it is the whole product of this
// component, and it is what live QA and the user's own bug reports quote back.
//
// The wiring — when this renders instead of the picker, and what "Control host" does to the URL — is
// mirrorJoinUrl.spec.ts, through the real MirrorApp.

function mountWaiting(
  over: { seatName?: string | null; message?: string | null; detail?: string | null } = {}
) {
  return mount(MirrorHostWaiting, {
    props: {
      seatName: over.seatName === undefined ? "Ann" : over.seatName,
      message: over.message ?? null,
      detail: over.detail ?? null
    }
  });
}

describe("MirrorHostWaiting", () => {
  it("says what it is waiting for, and who this browser will be", () => {
    const wrapper = mountWaiting({ seatName: "Ann" });
    expect(wrapper.find('[data-testid="mirror-host-waiting-title"]').text()).toBe(
      "Waiting for host to start game"
    );
    expect(wrapper.find('[data-testid="mirror-host-waiting-sub"]').text()).toBe(
      "You'll join as Ann when the host starts a game."
    );
  });

  it("trims the seat name it was given (a padded ?name=%20Ann%20 is the same seat)", () => {
    expect(mountWaiting({ seatName: "  Ann  " }).find('[data-testid="mirror-host-waiting-sub"]').text()).toBe(
      "You'll join as Ann when the host starts a game."
    );
  });

  // The heading alone is a complete sentence, so a viewer that reached this screen with no readable name simply
  // loses the second line rather than being shown "You'll join as  when…".
  it("drops the sub-line when no seat name is known", () => {
    for (const seatName of [null, "", "   "]) {
      const wrapper = mountWaiting({ seatName });
      expect(wrapper.find('[data-testid="mirror-host-waiting-sub"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="mirror-host-waiting-title"]').exists()).toBe(true);
    }
  });

  // NO SPINNER, and it is not an oversight. The spinner idiom means "something is in flight and will finish on its
  // own"; here we are waiting on a person to start a game on the TV, which may be an hour away. A spinner would
  // read as a hang on the very screen whose job is to look calm.
  it("shows no spinner — nothing here is in flight", () => {
    expect(mountWaiting().find('[data-testid="mirror-spinner"]').exists()).toBe(false);
    expect(mountWaiting().find(".mirror-spinner").exists()).toBe(false);
  });

  it("emits controlHost when the button is pressed, and nothing before that", async () => {
    const wrapper = mountWaiting();
    const button = wrapper.find('[data-testid="control-host"]');
    expect(button.text()).toBe("Control host");
    expect(wrapper.emitted("controlHost")).toBeUndefined();

    await button.trigger("click");
    expect(wrapper.emitted("controlHost")).toHaveLength(1);
  });

  // A stale rejection must stay legible when the host walks back to the menu — that is exactly the moment the
  // player goes looking for an explanation. Same testids as the picker's surface (MirrorJoinPicker), so one
  // rejection has one place to be read whichever screen the viewer is on when it lands.
  it("renders a rejection message + detail on the picker's own testids", () => {
    const wrapper = mountWaiting({
      message: "That name is not from a session player.",
      detail: "KeyNotFoundException: p:1003"
    });
    expect(wrapper.find('[data-testid="mirror-join-message"]').text()).toBe(
      "That name is not from a session player."
    );
    expect(wrapper.find('[data-testid="mirror-join-detail"]').text()).toBe(
      "KeyNotFoundException: p:1003"
    );
  });

  it("renders neither surface with no message, and never a detail without one above it", () => {
    const none = mountWaiting();
    expect(none.find('[data-testid="mirror-join-message"]').exists()).toBe(false);
    expect(none.find('[data-testid="mirror-join-detail"]').exists()).toBe(false);

    // A detail can never outlive the message it explains.
    const orphan = mountWaiting({ message: null, detail: "an orphaned fault string" });
    expect(orphan.find('[data-testid="mirror-join-detail"]').exists()).toBe(false);
  });

  // The panel box is the shared global `.assignment-panel` (styles.css), which is what makes this screen line up
  // with the picker AND with the advisory stacked above it — the width and its 720px breakpoint live there, once.
  it("wears the shared assignment-panel chrome", () => {
    const root = mountWaiting().find('[data-testid="mirror-host-waiting-view"]');
    expect(root.exists()).toBe(true);
    expect(root.classes()).toContain("assignment-panel");
    expect(root.attributes("aria-live")).toBe("polite");
  });
});
