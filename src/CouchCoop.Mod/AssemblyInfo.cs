using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("CouchCoop.Connection.Tests")]
// The Godot-less hosted-server harness (the game the frontend's e2e runs against) points CouchCoop's typed game facts at
// its fake runtime, so a browser join reads the same lobby or run it always did.
[assembly: InternalsVisibleTo("CouchCoop.HostedServerHarness")]
