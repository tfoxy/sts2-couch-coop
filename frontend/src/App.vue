<script setup lang="ts">
import MirrorApp from "@/mirror/MirrorApp.vue";
import InstallButton from "@/pwa/InstallButton.vue";

// Thin shell around the ONE client this app ships: MirrorApp, the live-tree mirror. It streams the
// host's actual Godot nodes, so animations come for free; it is a shared spectator view, and it works
// for other mods unchanged. MirrorApp owns the mirror surface / `data-testid="mirror-surface"` root.
//
// There is deliberately no view switch here: the live-tree mirror is the only browser client.
</script>

<template>
  <MirrorApp />
  <!-- Android install affordance, mounted at the app ROOT rather than inside the client: it is browser
       chrome that belongs to the shell, not to the mirror. Renders nothing at all unless Chrome has
       actually offered us a `beforeinstallprompt` (which needs the secure origin), so it is invisible on
       the default plain-HTTP LAN URL and on iOS, where Add-to-Home-Screen is guided separately. -->
  <InstallButton />
</template>
