// OWNER: Track Q (QA channel). A debug-only, LOCALHOST-ONLY line-oriented TCP control channel that lets device /
// desktop QA drive the native Godot client with structured verbs (input / settings / connect / state) instead of blind
// adb taps + screencap loops.
//
// SECURITY POSTURE (read before shipping):
//   * DEFAULT OFF. With no `--qa-port <n>` CLI arg and no `[qa] port=<n>` in user://settings.cfg, this node is never
//     mounted: zero listeners, zero threads, zero cost. It is a debug tool, not a product feature.
//   * LOCALHOST ONLY. The listener binds IPAddress.Loopback (127.0.0.1) exclusively — never 0.0.0.0 — so nothing off the
//     device can reach it. On Android a QA host reaches it with `adb forward tcp:<local> tcp:<port>` over USB.
//   * The Android enablement path is the settings.cfg key (Android apps cannot set process env). A QA host pushes a
//     `[qa]\nport=<n>` section into the app's user://settings.cfg via `run-as <pkg>` before launching a session.
//
// PROTOCOL: one command per line (exactly the DemoInputPlayer grammar), one response line per command — `ok [payload]`
// or `err <reason>`. `dump` / `dumpcards` / `state` return their payload as a single JSON line. Blank lines and `#`
// comments are ignored (no reply). Every command runs through the SAME DemoInputPlayer execution machinery (all work on
// the MAIN thread, frame-paced); the grammar is not forked.
//
// CONCURRENCY: exactly one client is served at a time (sequential connections are fine). A second connection while one
// is active is rejected politely (`err busy`, then closed). The accept loop + per-connection read loop run on background
// threads; each command line is handed to the main-thread player via EnqueueRemote and the background thread blocks for
// that command's single response before reading the next line — so the request/response order is strict.

using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using CouchCoop.GodotClient.Input;
using Godot;

namespace CouchCoop.GodotClient.App;

public sealed partial class QaServer : Node
{
    private readonly int _port;
    private readonly string _source; // "cli" | "settings.cfg" — logged so a session knows which gate opened the channel
    private DemoInputPlayer _player = null!;

    private TcpListener? _listener;
    private Thread? _acceptThread;
    private volatile bool _shutdown;
    private int _busy; // 0 = idle, 1 = a client is being served (Interlocked gate — rejects concurrent connections)

    public QaServer(int port, string source)
    {
        _port = port;
        _source = source;
    }

    public override void _Ready()
    {
        // The one DemoInputPlayer the QA channel feeds. It lives for the whole process (persists across connect /
        // disconnect cycles) and drains its queue on the main thread in _Process.
        _player = new DemoInputPlayer();
        AddChild(_player);

        try
        {
            _listener = new TcpListener(IPAddress.Loopback, _port);
            _listener.Start();
        }
        catch (Exception e)
        {
            GD.PrintErr($"QA: failed to bind 127.0.0.1:{_port} ({_source}): {e.Message} — QA channel disabled.");
            _listener = null;
            return;
        }

        _acceptThread = new Thread(AcceptLoop) { IsBackground = true, Name = "qa-accept" };
        _acceptThread.Start();
        GD.Print($"QA: listening on 127.0.0.1:{_port} (source={_source}). localhost-only, debug-only.");
    }

    public override void _ExitTree()
    {
        _shutdown = true;
        try
        {
            _listener?.Stop(); // unblocks AcceptTcpClient (throws SocketException, caught below)
        }
        catch (Exception)
        {
            // ignore — shutting down
        }

        _acceptThread?.Join(TimeSpan.FromSeconds(2));
    }

    // Accept one client at a time. A connection that arrives while another is being served is rejected politely.
    private void AcceptLoop()
    {
        while (!_shutdown)
        {
            TcpClient client;
            try
            {
                client = _listener!.AcceptTcpClient();
            }
            catch (Exception)
            {
                return; // listener stopped (shutdown) or a transient accept error — exit the loop
            }

            if (Interlocked.CompareExchange(ref _busy, 1, 0) != 0)
            {
                RejectBusy(client);
                continue;
            }

            // Serve this client on its own thread so the accept loop stays responsive (it can then reject a concurrent
            // connection instead of stalling in the OS backlog).
            var t = new Thread(() => Serve(client)) { IsBackground = true, Name = "qa-serve" };
            t.Start();
        }
    }

    private static void RejectBusy(TcpClient client)
    {
        try
        {
            using (client)
            using (var s = client.GetStream())
            {
                var bytes = Encoding.UTF8.GetBytes("err busy\n");
                s.Write(bytes, 0, bytes.Length);
            }
        }
        catch (Exception)
        {
            // best effort
        }
    }

    // Read commands line-by-line; for each, hand the line to the main-thread player and block for its single response,
    // then write it back. One response per command, in order.
    private void Serve(TcpClient client)
    {
        var remote = client.Client.RemoteEndPoint?.ToString() ?? "?";
        GD.Print($"QA: client connected ({remote}).");
        try
        {
            using (client)
            using (var stream = client.GetStream())
            using (var reader = new StreamReader(stream, Encoding.UTF8))
            using (var writer = new StreamWriter(stream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" })
            {
                string? line;
                while (!_shutdown && (line = reader.ReadLine()) != null)
                {
                    var trimmed = line.Trim();
                    if (trimmed.Length == 0 || trimmed.StartsWith("#", StringComparison.Ordinal))
                    {
                        continue; // blank / comment — not a command, no reply
                    }

                    string response = RunOnMainThread(trimmed);
                    if (_shutdown)
                    {
                        break;
                    }

                    writer.WriteLine(response);
                }
            }
        }
        catch (Exception e)
        {
            GD.Print($"QA: client loop ended ({remote}): {e.Message}");
        }
        finally
        {
            Interlocked.Exchange(ref _busy, 0);
            GD.Print($"QA: client disconnected ({remote}).");
        }
    }

    // Enqueue the line on the main-thread player and block (with periodic shutdown checks) until it produces its single
    // response. `wait`/`shot` legitimately take multiple frames — the loop just keeps waiting.
    private string RunOnMainThread(string line)
    {
        using var done = new ManualResetEventSlim(false);
        string result = "err no-response";
        _player.EnqueueRemote(line, r =>
        {
            result = r;
            done.Set();
        });

        while (!done.Wait(200))
        {
            if (_shutdown)
            {
                return "err shutdown";
            }
        }

        return result;
    }
}
