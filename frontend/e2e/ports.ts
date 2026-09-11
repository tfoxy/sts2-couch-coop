// E2E-only ports, deliberately OFF the app's real defaults (a live game hosts its browser
// server on 13337 and `npm run dev` serves 5173) so the suite can run alongside both.
export const RUN_HARNESS_PORT = 23337;
export const LOBBY_HARNESS_PORT = 23338;
export const DEV_ORIGIN_PORT = 25173;

export const RUN_HARNESS_ORIGIN = `http://127.0.0.1:${RUN_HARNESS_PORT}`;
export const LOBBY_BASE_URL = `http://127.0.0.1:${LOBBY_HARNESS_PORT}`;
export const DEV_ORIGIN = `http://127.0.0.1:${DEV_ORIGIN_PORT}`;

// Direct protocol observers do not go through MirrorClient's URL builder. Keep their query just as explicit as
// the browser client's: every selector is required and only canonical 0/1 values are accepted by the host.
export const DIRECT_WS_QUERY = "watch=0&staticBg=0&cardFlight=1&handTween=1&trailDrive=0";

export const RAW_TEST_RESOURCE_ROUTE = "/res/test-resource.tres";
