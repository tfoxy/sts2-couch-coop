# Hast du ein Problem? Poste es in der Steam-Diskussion

> Dies ist eine Übersetzung der Steam-Workshop-Diskussion [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Wenn du eine Frage stellen oder ein Problem melden möchtest, hinterlasse einen Kommentar in dieser Diskussion – du musst nicht auf Englisch schreiben, Deutsch ist völlig in Ordnung.

Poste in der [Steam-Diskussion](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/), wenn etwas schiefgeht: ein Absturz, ein Spieler, der beim Beitreten nicht weiterkommt, eine falsche Darstellung oder ein Run, der nicht mehr funktioniert.

**Wenn dein Handy oder Tablet die Beitrittsseite gar nicht öffnen kann**, lies zuerst [Keine Verbindung vom Handy oder Tablet?](phone-connection-troubleshooting.md). Die meisten Verbindungsprobleme liegen an einer WLAN-, Firewall- oder Router-Einstellung, die dort erklärt wird.

### Bevor du ein Problem beim Beitreten meldest

Das Spiel eines Spielers zu starten kann bis zu einer Minute dauern, besonders auf einem langsameren Computer. Solange die Zeile unter **Beitreten…** auf der Beitrittsseite weiter hochzählt und sich verändert, läuft der Start noch. Lass die Seite also offen.

---

## Was du angeben solltest

Du musst nicht alles beantworten. Die ersten beiden Punkte helfen am meisten.

### 1. Was passiert ist und was du erwartet hast

Ein oder zwei Sätze reichen. Falls ein Fehler angezeigt wurde, kopiere ihn genau, einschließlich der kleineren grauen Zeile darunter, oder poste einen Screenshot oder ein Foto des Bildschirms.

### 2. Der Verbindungsbericht (bei Problemen beim Beitreten oder in der Lobby)

*Überspringe diesen Punkt, wenn das Problem während eines Runs aufgetreten ist.*

Öffne auf dem Computer **Couch Co-Op-QR-Code** und schau unter **Verbindungen** nach. Wähle unter **Verbindungsprobleme** die fehlgeschlagene Verbindung aus, wähle **Bericht kopieren** und füge den Bericht in deinen Beitrag ein.

Er zeigt, welcher Schritt fehlgeschlagen ist und wie lange jeder Schritt gedauert hat. Er enthält auch die Einschätzung des Hosts, was schiefgegangen ist, und die Pfade zu den unten genannten Logdateien.

### 3. Die Logdateien

Wenn du den Verbindungsbericht kopiert hast, stehen die genauen Pfade bereits darin.

**Das Log des Spiels**, auf dem Host-Computer:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Die Logs der Spieler.** Für jeden Spieler, der beitritt, läuft eine eigene versteckte Kopie des Spiels auf dem Host-Computer, mit einem eigenen Log. Wenn ein Spieler beim Beitreten hängen geblieben ist, erklärt sein Log meist, warum; das Log des Spiels meist nicht.

Der erste Spieler, der beitritt, ist `slot-2`, der nächste `slot-3` und so weiter. Für `slot-2`:

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

Wenn es keinen Ordner `headless-slots` gibt, liegt das Log unter `couch-coop/seat-logs/slot-2.log`, im selben Ordner `SlayTheSpire2` wie das Log des Spiels.

**Welche Zeilen wichtig sind.** In beiden Logs brauche ich vor allem die Zeilen mit `[couchcoop]` (zum Beispiel `[INFO] [couchcoop] ...`) und alle Zeilen mit `[ERROR]`, auch wenn sie couchcoop nicht erwähnen. Diese Zeilen reichen meistens.

**Bevor du ein ganzes Log einfügst:** Diese Diskussion ist öffentlich. Ein Log enthält deine SteamID64 (eine lange Zahl, die mit 7656 beginnt und auf dein Steam-Profil verweist) und den Benutzernamen deines Computers in Dateipfaden. Es enthält keine Passwörter oder Konten anderer Spieler. Wenn du diese beiden Angaben nicht teilen möchtest, ersetze sie vor dem Einfügen oder poste nur die Zeilen mit `[couchcoop]` und `[ERROR]`. Ich frage nach, wenn ich mehr brauche.

### 4. Versionen und Mods

- Ob du auf dem **stabilen** Zweig oder auf dem **öffentlichen Beta**-Zweig des Spiels bist.
- **Welche anderen Mods du installiert hast.** Die Spielkopie jedes Spielers lädt dieselben Mods wie der Host. Deshalb kann eine andere Mod verhindern, dass ein Spieler beitritt, selbst wenn das Spiel des Hosts gut funktioniert.
- Das Betriebssystem des Hosts.
- Deine CouchCoop-Version, falls du sie kennst. Sonst gehe ich von der neuesten aus.

### 5. Alles, was hilft, das Problem einzugrenzen

- Passiert es jedes Mal oder nur manchmal?
- Passiert es bei jedem Spieler oder nur bei einem?
- Hat es vorher funktioniert, und hat sich seitdem etwas geändert, etwa durch ein Spiel-Update oder eine neue Mod?
