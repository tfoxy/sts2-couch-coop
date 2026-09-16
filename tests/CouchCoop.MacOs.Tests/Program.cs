// Custom executable runner: this intentionally source-links the production seeder and its existing suite, so
// macOS CI tests precisely the code a shipped seat uses without needing game assemblies or an STS2 install.
HeadlessUserDirSeederTests.Run();
Console.WriteLine("macOS user-dir farm: ok");
