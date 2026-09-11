// OWNER: WS-M (native input shim). M1e.
//
// Maps a Godot key to the browser KeyboardEvent.code string the host expects in InputMessage.Key (e.g. Key.Enter →
// "Enter", Key.Escape → "Escape", Key.Key1 → "Digit1"). This is the EXACT INVERSE of the server's accepted vocabulary
// — spirectl's Sts2BrowserKeyMap.TryMap(string code, out Key) (../spirectl/bridge-mod/.../Live/Sts2BrowserKeyMap.cs),
// which is what BrowserInputExecutor.BuildKey ultimately drives via SemanticActionKind.KeyInput. We produce only codes
// that map maps back to a real Godot key on the server, so a round trip (native Key → code → server Key) is stable.
//
// The InputRouter feeds ev.PhysicalKeycode (the physical-key identifier), which is exactly what a browser's
// KeyboardEvent.code names, so the letter/digit/numpad/function ranges map positionally.

using Godot;

namespace CouchCoop.GodotClient.Input;

public static class KeyMap
{
    // Returns true + the browser KeyboardEvent.code in `code` when `key` is mappable; false + "" otherwise.
    public static bool TryMap(Key key, out string code)
    {
        // Letters: Key.A..Key.Z → "KeyA".."KeyZ".
        if (key is >= Key.A and <= Key.Z)
        {
            code = "Key" + (char)('A' + (int)(key - Key.A));
            return true;
        }

        // Top-row digits: Key.Key0..Key.Key9 → "Digit0".."Digit9".
        if (key is >= Key.Key0 and <= Key.Key9)
        {
            code = "Digit" + (char)('0' + (int)(key - Key.Key0));
            return true;
        }

        // Numpad digits: Key.Kp0..Key.Kp9 → "Numpad0".."Numpad9".
        if (key is >= Key.Kp0 and <= Key.Kp9)
        {
            code = "Numpad" + (char)('0' + (int)(key - Key.Kp0));
            return true;
        }

        // Function keys: Key.F1..Key.F12 → "F1".."F12".
        if (key is >= Key.F1 and <= Key.F12)
        {
            code = "F" + (int)(key - Key.F1 + 1);
            return true;
        }

        switch (key)
        {
            case Key.Enter:
                code = "Enter";
                return true;
            case Key.KpEnter:
                code = "NumpadEnter";
                return true;
            case Key.Escape:
                code = "Escape";
                return true;
            case Key.Space:
                code = "Space";
                return true;
            case Key.Tab:
                code = "Tab";
                return true;
            case Key.Backspace:
                code = "Backspace";
                return true;
            case Key.Delete:
                code = "Delete";
                return true;
            case Key.Up:
                code = "ArrowUp";
                return true;
            case Key.Down:
                code = "ArrowDown";
                return true;
            case Key.Left:
                code = "ArrowLeft";
                return true;
            case Key.Right:
                code = "ArrowRight";
                return true;
            case Key.Home:
                code = "Home";
                return true;
            case Key.End:
                code = "End";
                return true;
            case Key.Pageup:
                code = "PageUp";
                return true;
            case Key.Pagedown:
                code = "PageDown";
                return true;
            case Key.Minus:
                code = "Minus";
                return true;
            case Key.Equal:
                code = "Equal";
                return true;
            default:
                code = "";
                return false;
        }
    }
}
