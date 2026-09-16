using CouchCoop.Mod.Tests;

if (args is ["--ws-lifecycle"])
{
    await WebSocketJoinLifecycleTests.RunAsync();
    await JoinProgressTickerTests.RunAsync();
    Console.WriteLine("connections: websocket lifecycle ok");
    return;
}

if (args is ["--routes"])
{
    Console.WriteLine("connections: control routes");
    await ConnectionControlRouteTests.RunAsync();
    // The other route-shaped contract: what the SPA document is served WITH (a per-response visit id, and the
    // no-store that keeps two devices from sharing one), and the arrival ring behind it.
    Console.WriteLine("connections: arrival log");
    await ConnectionArrivalLogTests.RunAsync();
    // …and the layer below both of those: the accept loop the SHIPPED host runs, which is the one that was
    // missing its HostReachabilityWatch call. Socket-driven, so it belongs with the route legs rather than
    // with the watch's own pure suite.
    Console.WriteLine("connections: reachability accept loop");
    await HostReachabilityAcceptLoopTests.RunAsync();
    // The default sink under every one of those diagnostics: recording into the process-wide arrival log from
    // a non-game process used to be a SIGSEGV, and this asserts it is now inert.
    Console.WriteLine("connections: native log latch");
    NativeLogLatchTests.Run();
    // The join reply's own envelope field: which `joinRejection` code a refused join is answered with, and so
    // which copy the phone renders for it.
    Console.WriteLine("connections: seat rejection codes");
    SeatRejectionCodeTests.Run();
    Console.WriteLine("connections: control routes ok");
    return;
}

// The host's own diagnostics: whether this process could install its Harmony hooks, and how a degraded host
// condition reaches the panel without reading as a stopped session.
if (args is ["--patch-health"])
{
    Console.WriteLine("connections: host patch health");
    HostPatchHealthTests.Run();
    // The other host-condition row: a listener that is up and has never been reached. Same family — a host
    // problem with no client behind it — and the same panel surface, so it is verified from the same verb.
    Console.WriteLine("connections: host reachability");
    HostReachabilityWatchTests.Run();
    Console.WriteLine("connections: host patch health ok");
    return;
}

if (args is ["--labels"])
{
    Console.WriteLine("connections: device label");
    ConnectionDeviceLabelTests.Run();
    Console.WriteLine("connections: device label ok");
    return;
}

if (args is ["--host-ui"])
{
    Console.WriteLine("host ui: button activation");
    CouchCoopButtonActivationTests.Run();
    Console.WriteLine("host ui: modal focus");
    CouchCoopModalFocusTests.Run();
    Console.WriteLine("host ui: modal focus chain");
    CouchCoopModalFocusChainTests.Run();
    Console.WriteLine("host ui: localization");
    CouchCoopLocalizationTests.Run();
    Console.WriteLine("host ui: connections");
    ConnectionUiTests.Run();
    Console.WriteLine("host ui: connection attention");
    ConnectionAttentionTests.Run();
    Console.WriteLine("host ui: ok");
    return;
}

if (args is ["--seats"])
{
    Console.WriteLine("seats: allocator and teardown");
    await HeadlessClientManagerTests.RunAsync();
    Console.WriteLine("seats: port truth");
    await SeatPortTruthTests.RunAsync();
    // The other half of the readiness verdict: the seat's own evidence that a device reached it, which is what
    // the network-path cause is allowed to rest on.
    Console.WriteLine("seats: arrival evidence");
    await SeatArrivalEvidenceTests.RunAsync();
    // …and the last leg of that evidence: the verdict reaching the PHONE, which is the one surface that could
    // not see any of the four causes before.
    Console.WriteLine("seats: notice to the browser");
    SeatNoticeTests.Run();
    Console.WriteLine("seats: ok");
    return;
}

// "A seat runs the same copy of CouchCoop as its host": the seeded mod-list pin and the build guard whose
// failure becomes the `seat-build-mismatch` connection issue the lifecycle leg below asserts.
if (args is ["--seat-build"])
{
    Console.WriteLine("seat build: mod selection and build guard");
    SeatModBuildTests.Run();
    Console.WriteLine("seat build: ok");
    return;
}

Console.WriteLine("connections: registry");
ConnectionRegistryTests.Run();
Console.WriteLine("connections: host patch health");
HostPatchHealthTests.Run();
Console.WriteLine("connections: host reachability");
HostReachabilityWatchTests.Run();
Console.WriteLine("connections: device label");
ConnectionDeviceLabelTests.Run();
Console.WriteLine("connections: report formatter");
await ConnectionReportFormatterTests.Run();
Console.WriteLine("connections: attempt logs");
await ConnectionAttemptLogsTests.Run();
Console.WriteLine("connections: control");
await ConnectionControlTests.RunAsync();
Console.WriteLine("connections: status");
await ConnectionStatusTests.RunAsync();
Console.WriteLine("connections: disconnect exit");
await HeadlessDisconnectExitTests.RunAsync();
Console.WriteLine("connections: control routes");
await ConnectionControlRouteTests.RunAsync();
Console.WriteLine("connections: arrival log");
await ConnectionArrivalLogTests.RunAsync();
Console.WriteLine("connections: reachability accept loop");
await HostReachabilityAcceptLoopTests.RunAsync();
Console.WriteLine("connections: native log latch");
NativeLogLatchTests.Run();
Console.WriteLine("connections: seat build");
SeatModBuildTests.Run();
Console.WriteLine("connections: seat port truth");
await SeatPortTruthTests.RunAsync();
Console.WriteLine("connections: seat arrival evidence");
await SeatArrivalEvidenceTests.RunAsync();
Console.WriteLine("connections: seat notice");
SeatNoticeTests.Run();
Console.WriteLine("connections: seat rejection codes");
SeatRejectionCodeTests.Run();
Console.WriteLine("connections: lifecycle");
await HeadlessConnectionLifecycleTests.RunAsync();
Console.WriteLine("connections: websocket lifecycle");
await WebSocketJoinLifecycleTests.RunAsync();
Console.WriteLine("connections: join progress");
await JoinProgressTickerTests.RunAsync();
Console.WriteLine("connections: ok");
