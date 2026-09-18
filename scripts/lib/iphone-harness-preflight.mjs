const target = process.argv[2];
if (!target) throw new Error("usage: iphone-harness-preflight.mjs URL");
const url = new URL(target);
if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("harness URL must be HTTP(S)");

const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5_000) });
if (!response.ok) throw new Error(`HTTP preflight failed: ${response.status}`);

const socketUrl = new URL("/ws", url);
socketUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
socketUrl.searchParams.set("watch", "0");
socketUrl.searchParams.set("staticBg", "0");
socketUrl.searchParams.set("cardFlight", "1");
socketUrl.searchParams.set("handTween", "1");
socketUrl.searchParams.set("trailDrive", "0");
await new Promise((resolve, reject) => {
  const socket = new WebSocket(socketUrl);
  const timer = setTimeout(() => {
    socket.close();
    reject(new Error("WebSocket preflight timed out"));
  }, 5_000);
  socket.addEventListener("open", () => socket.close(1000, "preflight"));
  socket.addEventListener("close", () => {
    clearTimeout(timer);
    resolve();
  });
  socket.addEventListener("error", () => {
    clearTimeout(timer);
    reject(new Error("WebSocket preflight failed"));
  });
});

process.stdout.write("iphone-harness-preflight: ok\n");
