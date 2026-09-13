using CouchCoop.Mod.Tests;

if (args is ["--ws-lifecycle"])
{
    await WebSocketJoinLifecycleTests.RunAsync();
    Console.WriteLine("connections: websocket lifecycle ok");
    return;
}

if (args is ["--routes"])
{
    Console.WriteLine("connections: control routes");
    await ConnectionControlRouteTests.RunAsync();
    Console.WriteLine("connections: control routes ok");
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
    Console.WriteLine("host ui: ok");
    return;
}

if (args is ["--seats"])
{
    Console.WriteLine("seats: allocator and teardown");
    await HeadlessClientManagerTests.RunAsync();
    Console.WriteLine("seats: ok");
    return;
}

Console.WriteLine("connections: registry");
ConnectionRegistryTests.Run();
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
Console.WriteLine("connections: lifecycle");
await HeadlessConnectionLifecycleTests.RunAsync();
Console.WriteLine("connections: websocket lifecycle");
await WebSocketJoinLifecycleTests.RunAsync();
Console.WriteLine("connections: ok");
