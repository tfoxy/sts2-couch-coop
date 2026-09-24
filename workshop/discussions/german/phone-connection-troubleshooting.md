# Keine Verbindung vom Handy oder Tablet?

> Dies ist eine Übersetzung der Steam-Workshop-Diskussion [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Wenn du eine Frage stellen oder ein Problem melden möchtest, hinterlasse einen Kommentar in dieser Diskussion – du musst nicht auf Englisch schreiben, Deutsch ist völlig in Ordnung.

Die meisten Verbindungsprobleme lassen sich auf eine Handvoll Ursachen zurückführen. Diese Liste ist grob von der häufigsten zur seltensten sortiert, es lohnt sich also, sie der Reihe nach durchzugehen.

*Wenn dein Handy die Beitrittsseite problemlos erreicht und das Problem woanders liegt - ein Absturz, ein Spieler, der nie fertig beitritt, etwas, das im Spiel selbst nicht stimmt -, lies stattdessen [Hast du ein Problem? Poste es in der Steam-Diskussion](reporting-a-problem.md).*

---

## Was du ausprobieren kannst

### 1. Wähle auf dem QR-Bildschirm eine andere Adresse

Der QR-Bildschirm hat eine Auswahl mit mehreren Wegen, den Host zu erreichen. Wenn der gescannte nicht funktioniert, wähle einen anderen und scanne erneut.

Nimm am besten die einfache numerische Adresse (etwa **192.168.1.5:13337**). Bei ihr kann am wenigsten schiefgehen. Der **.local**-Name und der Weblink hängen beide von Dingen außerhalb der Mod ab - deinem Router, einer Internetverbindung, Browser-Berechtigungen - und können deshalb in einem Netzwerk scheitern, in dem die numerische Adresse einwandfrei funktioniert.

**Überspringe auf einem iPhone oder iPad die Zeile *Weblink* komplett.** Safari - und jeder andere Browser unter iOS, weil sie alle im Kern Safari sind - lässt eine aus dem Internet geladene Seite nichts in deinem Heimnetzwerk erreichen. Das ist eine Regel des Browsers, keine Einstellung, es gibt also nichts zu erlauben und nichts zu ändern: Die Seite lädt und meldet dann, dass das Spiel nicht geantwortet hat - in jedem Netzwerk, egal wie deine Firewall eingestellt ist. Nutze auf einem iPhone oder iPad **Einfache Adresse** oder **Sicherer Link**. (Die Seite sagt das inzwischen selbst, falls du so weit kommst.)

### 2. Stelle sicher, dass das Handy wirklich im selben Netzwerk ist

- Im selben WLAN wie der Host-Computer, und nicht im **Gast**-Netzwerk. Gastnetzwerke verhindern meist, dass Geräte miteinander kommunizieren - und genau das wird hier gebraucht.
- Nicht über mobile Daten. Wenn das WLAN keinen Internetzugang hat, wechseln Handys manchmal von selbst zu den mobilen Daten, ohne dir Bescheid zu sagen.
- **Schalte jedes VPN auf dem Handy aus.** Darüber stolpern viele. Werbeblocker und „Privates DNS“-Apps, die als VPN laufen, zählen auch dazu.

### 3. Lies, was die Seite beim Beitreten anzeigt

Das Spiel eines Spielers zu starten kann bis zu einer Minute dauern, und das ist normal und kein Fehler. Währenddessen zeigt dir die Seite jetzt in einer Zeile unter *Beitritt…* an, wie weit sie ist:

*Verbindung zum Gastgeber wird hergestellt – Schritt 1 von 6, bisher 14 s. Das kann bis zu einer Minute dauern, lassen Sie diese Seite geöffnet.*

Wenn diese Zeile hochzählt und die Phase wechselt, läuft alles - lass die Seite offen. Die sechs Phasen sind „Verbindung zum Gastgeber wird hergestellt“, „Warten auf den Gastgeber“, „Das Spiel dieses Spielers wird gestartet“, „Dieser Spieler tritt dem Spiel bei“, „Die Spielansicht wird geladen“ und „Fast fertig“.

### 4. Wenn es hängen bleibt, sagt dir die Seite jetzt, WARUM

Wenn tatsächlich etwas schiefgeht, erfährt dein Gerät, welche von mehreren voneinander unabhängigen Ursachen es war - in zwei Sätzen plus einer grauen technischen Zeile. **Bitte gib bei jeder Meldung alles davon an.** Es gibt drei mögliche Meldungen, und sie brauchen völlig unterschiedliche Lösungen:

- „**Ihr Spiel läuft auf dem Host-Computer, aber dieses Gerät konnte es nicht erreichen.**“\
  Hier geht es um den Netzwerkweg zwischen deinem Handy und dem Host - Gast-WLAN, ein VPN oder ein Router, der Geräte voneinander trennt. Mit dem Spiel des Hosts ist alles in Ordnung. Siehe Abschnitte 2 und 6.
- „**Ein anderes Programm auf dem Host-Computer belegt den Port, den Ihr Spiel benötigt.**“\
  Auf deinem Gerät musst du nichts ändern. Auf dem Host belegt etwas anderes einen der Ports, die jeder Spieler braucht - meistens ein übrig gebliebener Spielerprozess aus einer früheren Sitzung. Wer hostet, sollte ihn beenden (ein Neustart von Slay the Spire 2 räumt ihn weg).
- „**Der Host-Computer blockiert den Port, über den Ihr Spiel bereitgestellt wird.**“\
  Auch hier musst du auf deinem Gerät nichts ändern. Die Firewall oder Sicherheitssoftware des Hosts selbst blockiert ihn - siehe Abschnitt 5.

**Der häufigste Blockierfall zeigt überhaupt kein *Beitritt…* an.** Wenn dein Gerät den Host erreicht hat, aber nicht den Port, der deinem eigenen Spieler zugewiesen wurde, *gelingt* der Beitritt - und die Seite wechselt dann zu *Laden…* und bleibt dort stehen. Auf diesem Bildschirm gibt es weder eine Fortschrittszeile noch einen Countdown, weil aus Sicht des Hosts nichts fehlgeschlagen ist. Das Erste, was du Nützliches siehst, ist die obige Meldung „**konnte es nicht erreichen**“, etwa **20 Sekunden** nachdem die Seite gewechselt hat. Also: Wenn du bei *Laden…* hängst, warte eine halbe Minute auf diese Meldung, statt neu zu laden - ein Neuladen startet die ganze Wartezeit von vorn.

Wenn die Seite dagegen bei *Beitritt…* stehen bleibt und sich nie ändert, gibt der Host nach 75 Sekunden mit „*Die Spielansicht konnte nicht gestartet werden. Bitte versuchen Sie es erneut.*“ und einer grauen Zeile darunter auf. Das ist ein anderer Fehler als der obige. So oder so: Kopiere, was dort steht.

### 5. Jeder Spieler nutzt einen eigenen Port

Die Lobby läuft auf **13337**, danach nutzt jeder Spieler **13357**, **13367**, **13377** und so weiter. Eine Firewall-Regel, die nur 13337 öffnet, lässt dich die Spielerliste erreichen und scheitert dann beim zweiten Schritt. Falls du (oder eine Anleitung, der du gefolgt bist) so eine Regel angelegt hast, entferne sie und erlaube stattdessen **das Spielprogramm** - das deckt alle Ports ab, die es braucht.

### 6. Windows: Lass das Spiel durch die Firewall

Prüfe zuerst den Netzwerktyp, denn allein der blockiert viele Verbindungen:

- **Einstellungen > Netzwerk und Internet > WLAN** (oder Ethernet) > klicke auf dein Netzwerk > setze **Netzwerkprofiltyp** auf **Privates Netzwerk**.

Dann erlaube das Spiel:

- **Einstellungen > Datenschutz und Sicherheit > Windows-Sicherheit > Firewall & Netzwerkschutz > Zugriff von App durch Firewall zulassen**
- Suche **Slay the Spire 2** in der Liste und stelle sicher, dass **Privat** angehakt ist. Wenn es nicht in der Liste steht, verwende **Andere App zulassen...** und wähle die `.exe`-Datei des Spiels aus.

Wenn du irgendwann bei einer Abfrage der Windows-Firewall auf „Abbrechen“ geklickt hast, merkt sich Windows das als Blockierregel und fragt nie wieder nach. In diesem Fall musst du den oben genannten Eintrag entfernen und neu hinzufügen.

**Die Adresse in einem Browser auf dem Host-PC selbst zu öffnen, beweist gar nichts.** Das liegt nahe, ist aber nachweislich irreführend: Windows filtert keinen Datenverkehr eines Computers an sich selbst - nicht einmal an seine eigene Netzwerkadresse -, deshalb lädt der Browser des Hosts die Seite einwandfrei, selbst wenn die Firewall jedes Handy aktiv blockiert. Wenn das bei dir funktioniert hat, weißt du, dass das Spiel läuft und die Seite ausliefert. Über die Firewall sagt es überhaupt nichts aus.

Hake **Öffentlich** nur an, wenn dein Netzwerk auf Öffentlich eingestellt ist und du das nicht ändern kannst. Damit wird das Spiel in jedem Netzwerk erreichbar, mit dem du dich verbindest, auch in Cafés und Hotels.

### 7. Der Router

Manche Router verhindern, dass sich Geräte im selben WLAN gegenseitig erreichen. Such nach einer Einstellung namens **AP isolation**, **Client isolation** oder **Wireless isolation** (auf Deutsch oft „AP-Isolierung“) und schalte sie aus.

Auch gut zu wissen: Ein WLAN-Repeater oder Powerline-Adapter, der im **Router**-Modus statt im **Bridge**- / **Access-Point**-Modus eingerichtet ist, bringt dein Handy in ein anderes Netzwerk als den Host, auch wenn der WLAN-Name gleich aussieht.

### 8. Browser-Einstellungen, die einfache Adressen blockieren

Manche Browser versuchen, jede Adresse auf HTTPS zu zwingen - und die einfache numerische Adresse nutzt kein HTTPS. (Die Zeile **Sicherer Link** auf dem QR-Bildschirm tut das - wenn also erzwungenes HTTPS das Problem ist, lohnt sich auch ein Versuch mit dieser Zeile.) Wenn die Adressleiste statt des Spiels eine Sicherheitswarnung zeigt, schalte diese Optionen aus und versuche es erneut:

- Chrome: **Einstellungen > Datenschutz und Sicherheit > Sicherheit > Immer verschlüsselte Verbindungen verwenden**
- Firefox: **Einstellungen > Datenschutz & Sicherheit > Nur-HTTPS-Modus**

Prüfe auf dem iPhone außerdem unter **Einstellungen > Apps > Safari** das iCloud Privat-Relay und „IP-Adresse verbergen“.

### 9. Antivirenprogramme mit eigener Firewall

Sicherheitspakete wie ESET, Bitdefender, Norton, Kaspersky und Avast haben eine eigene Firewall, getrennt von der von Windows. Das Spiel in Windows zu erlauben, bringt für diese nichts. Prüfe die Netzwerk- oder Firewall-Einstellungen des Sicherheitspakets selbst oder pausiere dessen Firewall kurz, um zu sehen, ob sie die Ursache ist.

### 10. Wenn es früher funktioniert hat und dann nicht mehr

Die Adresse des Host-Computers kann sich ändern, wenn er sich neu mit dem WLAN verbindet oder nachdem der Router neu gestartet wurde. Öffne den QR-Bildschirm erneut und scanne noch einmal - dort steht dann die neue Adresse.

Wenn du den Client zu deinem Home-Bildschirm hinzugefügt hast, hängt das Weitere davon ab, aus welcher Zeile du ihn installiert hast:

- Aus der Zeile **Weblink** installiert: Er funktioniert weiter und findet die neue Adresse von selbst. Einfach öffnen - kein erneutes Scannen nötig.
- Aus der **numerischen Adresse** oder der Zeile **Sicherer Link** installiert: Das Symbol zeigt auf die alte Adresse und kann sich davon nicht erholen. Lösche es und füge es nach dem erneuten Scannen wieder hinzu. (Unter Android vermeidest du das dauerhaft, wenn du stattdessen aus der Zeile **Weblink** installierst. Auf einem iPhone oder iPad kann diese Zeile nicht funktionieren - siehe Abschnitt 1 -, dort bleibt also nur, das Symbol neu hinzuzufügen.)

---

## Kommst du immer noch nicht weiter? Kommentiere in der Steam-Diskussion

Hinterlasse einen Kommentar in der [Steam-Diskussion](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) - du musst nicht alles beantworten. Schon ein oder zwei dieser Angaben machen eine Meldung viel leichter zu bearbeiten, und die erste Frage ist mehr wert als alle anderen zusammen.

### Wie weit kommt es?

Das ist das Nützlichste, was du mir sagen kannst, weil jede Antwort auf eine andere Ursache hinweist:

- der Browser lädt überhaupt nichts
- die Seite lädt, aber die Spielerliste erscheint nie
- du kannst einen Namen wählen, aber es bleibt bei „Beitritt…“ stehen - sag mir, was die Fortschrittszeile darunter anzeigte und welche Meldung du bekommen hast, falls du gewartet hast
- es kommt darüber hinaus und bleibt stattdessen bei „**Laden…**“ stehen - das ist der Port-/Firewall-Fall, und er ist der häufigste. Sag mir, ob nach etwa 20 Sekunden die Meldung „konnte es nicht erreichen“ erschienen ist
- die Verbindung klappte, brach dann aber während des Runs ab

### Was du sonst noch angeben kannst

- Die genaue Meldung, die das Handy anzeigt, einschließlich der grauen Zeile darunter. Ein Foto des Bildschirms ist perfekt.
- Welche Adresse du gescannt hast - die numerische, den **.local**-Namen oder den Weblink.
- Betriebssystem des Hosts sowie Modell und Browser des Handys bzw. Tablets.
- Schlägt es auf **jedem** Gerät fehl oder nur auf einem? Wenn ein Handy funktioniert und ein anderes nicht, schließt das schon viel aus.
- Hat es früher schon einmal funktioniert, und hat sich seitdem etwas geändert?
- Host per WLAN oder Ethernet? Läuft ein VPN auf dem Host oder dem Handy? Ein Antivirenprogramm mit Firewall?

### Drei Dinge, die dir der Host-Computer liefern kann

- **Das Verbindungs-Panel.** Öffne auf dem Host den Bildschirm **Couch Co-Op-QR-Code** - dort findest du unter dem Code das Panel **Verbindungen**. Geräte, die weit genug gekommen sind, um dort aufzutauchen, werden aufgelistet, und alles, was schiefgegangen ist, wird unter **Verbindungsprobleme** (mit einer Anzahl dahinter) aufbewahrt. Wähle die Zeile aus und nutze **Bericht kopieren** - das kopiert einen Bericht, der den fehlgeschlagenen Schritt, die Zeiten und die Diagnose des Hosts selbst bereits enthält. Füge ihn direkt in deinen Kommentar ein. Er nennt auch den genauen Pfad der beiden Logdateien unten, sodass du nicht danach suchen musst.
- **Die Haupt-Logdatei.** Unter Windows `%APPDATA%\SlayTheSpire2\logs\godot.log`. Unter Linux `~/.local/share/SlayTheSpire2/logs/godot.log`. Unter macOS `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **Das Log pro Spieler.** Jeder Spieler, der beitritt, bekommt seine eigene Kopie des Spiels, die im Hintergrund auf dem Host läuft, und jede führt ihr eigenes Log. **Wenn die Seite bis *Beitritt…* gekommen ist und es dann zu einer Zeitüberschreitung kam, erklärt diese Datei, warum** - das Haupt-Log oben meist nicht. Die Spieler werden ab 2 nummeriert, der erste Mitspieler, der beitritt, ist also `slot-2`: Unter Linux ist das `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` (ja, zweimal `SlayTheSpire2` - kein Tippfehler), und die Pfade unter Windows und macOS folgen demselben Aufbau unter den oben genannten Ordnern. Bei manchen Setups ist es stattdessen eine einzelne Datei unter `couch-coop/seat-logs/slot-2.log`.

**Welche Zeilen wichtig sind.** In beiden Logs enthalten die nützlichen Zeilen `[couchcoop]` - sie sehen aus wie `[INFO] [couchcoop] ...` -, dazu alle `[ERROR]`-Zeilen, auch solche, die couchcoop nicht erwähnen. Die reichen meist schon für sich.

**Bevor du ein ganzes Log einfügst:** Die Steam-Diskussion ist öffentlich, und ein Log enthält deine eigene **SteamID64** (eine lange Zahl, die mit 7656 beginnt und auf dein Steam-Profil verweist) und den **Benutzernamen** deines Computers in Dateipfaden. Es enthält *keine* Passwörter und auch keine Konten anderer Spieler - nur deins. Wenn du das nicht posten möchtest, reicht es, diese beiden Angaben vor dem Einfügen per Suchen und Ersetzen zu ändern, oder poste einfach nur die `[couchcoop]`- und `[ERROR]`-Zeilen, und ich frage nach, wenn ich mehr brauche.

---

Noch ein letzter Hinweis: Jeder, der die Beitrittsadresse erreichen kann, kann den Client öffnen und mitspielen, also nutze das nur in einem Netzwerk, dem du vertraust.
