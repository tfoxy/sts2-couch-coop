# Hast du ein Problem? Poste es in der Steam-Diskussion

> Dies ist eine Übersetzung der Steam-Workshop-Diskussion [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Wenn du eine Frage stellen oder ein Problem melden möchtest, hinterlasse einen Kommentar in dieser Diskussion – du musst nicht auf Englisch schreiben, Deutsch ist völlig in Ordnung.

Die [Steam-Diskussion](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) ist der richtige Ort für alles, was schiefgeht - Abstürze, ein Spieler, der nie fertig beitritt, etwas, das falsch dargestellt wird, ein Run, der kaputtgeht.

**Wenn dein Handy oder Tablet die Beitrittsseite überhaupt nicht erreicht**, lies zuerst [Keine Verbindung vom Handy oder Tablet?](phone-connection-troubleshooting.md) - dort geht es ausführlich um WLAN, Firewalls und Router, und die meisten Verbindungsprobleme lassen sich damit lösen.

---

## Was du angeben solltest

Du musst nicht alles beantworten - die ersten beiden Punkte sind mehr wert als der ganze Rest zusammen.

### 1. Was passiert ist und was du stattdessen erwartet hast

Ein oder zwei Sätze reichen. Wenn eine Fehlermeldung auf dem Bildschirm stand, gib sie wortwörtlich wieder, einschließlich einer eventuellen kleineren grauen Zeile darunter. Ein Foto oder Screenshot ist perfekt.

### 2. Wenn es um das Beitreten oder die Lobby geht: der Verbindungsbericht

*Wenn dein Problem später auftritt - während eines Runs oder im Spiel selbst -, spring direkt zu Schritt 3.*

Öffne aus der Lobby den Bildschirm **Couch Co-Op-QR-Code**. Dort findest du unter dem Code das Panel **Verbindungen**. Alles, was schiefgegangen ist, wird unter **Verbindungsprobleme** (mit einer Anzahl dahinter) aufbewahrt.

Wähle die fehlgeschlagene Zeile aus, klicke auf **Bericht kopieren** und füge den Bericht in deinen Kommentar ein. Bei einem Beitrittsproblem ist das mit Abstand das Nützlichste, was du anhängen kannst: Er enthält bereits den fehlgeschlagenen Schritt, die Zeiten, die Diagnose des Hosts selbst und die Pfade zu den unten beschriebenen Logdateien.

### 3. Die Logdateien

Es gibt zwei Arten, und welche wichtig ist, hängt vom Problem ab.

**Das Haupt-Log des Spiels**, auf dem Host-Computer:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Das Log pro Spieler.** Jeder Spieler, der beitritt, bekommt seine eigene Kopie des Spiels, die im Hintergrund auf dem Host-Computer läuft, und jede führt ihr eigenes Log. **Wenn ein Spieler beim Beitreten hängen geblieben ist, erklärt diese Datei, warum** - das Haupt-Log oben meist nicht.

Die Spieler werden ab 2 nummeriert, der erste Mitspieler, der dir beitritt, ist also `slot-2`. Unter Linux liegt das Log dieses Spielers hier:

`~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`

(Ja, `SlayTheSpire2` kommt wirklich zweimal vor - das ist kein Tippfehler.) Unter Windows und macOS ist der Aufbau derselbe, unter dem Ordner aus der Liste oben. Bei manchen Setups ist es stattdessen eine einzelne Datei unter `couch-coop/seat-logs/slot-2.log`. So oder so **nennt der Bericht aus Schritt 2 den genauen Pfad**, wenn du ihn also zuerst kopierst, musst du nicht suchen.

**Welche Zeilen wichtig sind.** In beiden Dateien enthalten die nützlichen Zeilen `[couchcoop]` - sie sehen aus wie `[INFO] [couchcoop] ...` -, dazu alle `[ERROR]`-Zeilen, auch solche, die couchcoop nicht erwähnen. Diese Zeilen reichen meist schon für sich.

**Bevor du ein ganzes Log einfügst:** Die Steam-Diskussion ist öffentlich, und ein Log enthält deine eigene **SteamID64** (eine lange Zahl, die mit 7656 beginnt und auf dein Steam-Profil verweist) und den **Benutzernamen** deines Computers in Dateipfaden. Es enthält *keine* Passwörter und auch keine Konten anderer Spieler - nur deins. Wenn du das nicht posten möchtest, reicht es, diese beiden Angaben vor dem Einfügen per Suchen und Ersetzen zu ändern, oder poste einfach nur die `[couchcoop]`- und `[ERROR]`-Zeilen, und ich frage nach, wenn ich mehr brauche.

### 4. Versionen und Mods

- Ob du auf dem **stabilen** Zweig oder auf dem **öffentlichen Beta**-Zweig des Spiels bist.
- **Welche anderen Mods installiert sind.** Jede Spielerkopie im Hintergrund lädt dieselben Mods wie der Host, deshalb kann eine andere Mod verhindern, dass ein Spieler fertig beitritt, selbst wenn das Spiel des Hosts völlig in Ordnung aussieht.
- Betriebssystem des Hosts.
- Die CouchCoop-Version, falls du sie kennst - sonst gehe ich von der neuesten aus.

### 5. Alles, was es eingrenzt

- Passiert es jedes Mal oder nur manchmal?
- Passiert es bei jedem Spieler oder nur bei einem?
- Hat es früher schon einmal funktioniert, und hat sich seitdem etwas geändert - ein Spiel-Update, eine neue Mod?

---

## Eine Sache, die du vor einer Meldung wissen solltest

Das Spiel eines Spielers zu starten kann bis zu einer Minute dauern, und auf einem langsameren Rechner wird der Großteil davon auch gebraucht. Das ist normal und kein Fehler. Während es läuft, zählt die Beitrittsseite unter *Beitritt…* hoch und wechselt die Phase - solange sich diese Zeile noch bewegt, ist noch nichts schiefgegangen, also lass die Seite offen.
