# Keine Verbindung vom Handy oder Tablet?

> Dies ist eine Übersetzung der Steam-Workshop-Diskussion [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Wenn du eine Frage stellen oder ein Problem melden möchtest, hinterlasse einen Kommentar in dieser Diskussion – du musst nicht auf Englisch schreiben, Deutsch ist völlig in Ordnung.

Probiere diese Schritte, wenn sich dein Handy oder Tablet nicht verbinden kann. Bei Abstürzen oder Problemen während eines Laufs lies [Du hast ein Problem? Melde es in der Steam-Diskussion](reporting-a-problem.md).

### 1. Wähle die Verbindungseinstellungen

Öffne auf dem Computer, auf dem das Spiel läuft, **Couch Co-Op-QR-Code**.

- **Netzwerkschnittstelle** (links): Wähle **Kabelgebunden (Ethernet)**, wenn der Computer per Kabel am Router hängt, oder **WLAN**, wenn er drahtlos verbunden ist. Wähle die Verbindung zu dem Router, den dein Handy nutzt. Überspringe **PC-Name (.local)**.
- **Verbindungsmethode** (rechts): Wähle **Direkte Adresse**, ohne „(HTTPS)“. Die Adresse sollte mit `http://` beginnen, zum Beispiel `http://192.168.1.5:13337`.

Scanne den QR-Code nach dem Ändern dieser Einstellungen erneut.

Verwende bei der Fehlersuche **Direkte Adresse**. Die HTTPS-Methoden sind zusätzliche Optionen für Leistung und Sicherheit und erfordern weitere Einrichtung oder Verbindungsvoraussetzungen.

### 2. Prüfe das Netzwerk des Handys

- Verbinde das Handy mit deinem Heim-WLAN, nicht mit dem **Gastnetz**. Der Computer kann WLAN oder ein Kabel zum selben Router verwenden.
- Stelle sicher, dass das Handy WLAN statt mobiler Daten nutzt.
- Trenne vorübergehend alle VPN-Verbindungen auf dem Handy oder Computer. Dazu zählen auch Werbeblocker auf dem Handy, die eine VPN-Verbindung nutzen.

**Wenn sich die Seite öffnet, aber der Beitritt hängen bleibt, gehe zu Schritt 6.**

### 3. Windows: Lass das Spiel durch die Firewall

In deinem Heimnetzwerk:

1. **Einstellungen > Netzwerk und Internet > WLAN** (oder Ethernet) > klicke auf dein Netzwerk > setze **Netzwerkprofiltyp** auf **Privates Netzwerk**.
2. **Einstellungen > Datenschutz und Sicherheit > Windows-Sicherheit > Firewall & Netzwerkschutz > Zugriff von App durch Firewall zulassen**
3. Suche **Slay the Spire 2** in der Liste und stelle sicher, dass **Privat** angehakt ist. Wenn es nicht in der Liste steht, verwende **Andere App zulassen...** und wähle die `.exe`-Datei des Spiels aus.

Wenn du die Firewall-Abfrage für das Spiel früher abgebrochen hast, entferne den blockierten Eintrag und füge das Spiel erneut hinzu.

Falls dein Antivirenprogramm eine eigene Firewall hat, erlaube das Spiel auch dort.

Die Adresse auf dem Computer zu öffnen, auf dem das Spiel läuft, prüft nicht, ob die Firewall die Verbindung deines Handys zulässt.

### 4. Prüfe, ob der Browser HTTPS erzwingt

Die Methode **Direkte Adresse** verwendet `http://`. Wenn dein Browser daraus `https://` machen will, prüfe seine Einstellung für sichere Verbindungen:

- Chrome: **Einstellungen > Datenschutz und Sicherheit > Sicherheit > Immer verschlüsselte Verbindungen verwenden**
- Firefox: **Einstellungen > Datenschutz & Sicherheit > Verbindungs- und Softwaresicherheit > Erweiterte Einstellungen > Nur-HTTPS-Modus**

Erlaube die HTTP-Adresse und scanne den QR-Code erneut. Lass auf dem Computer **Direkte Adresse** ausgewählt.

### 5. Prüfe den Router

Gast-WLAN verhindert häufig, dass Geräte miteinander kommunizieren. Verwende das normale Heimnetzwerk.

Wenn beide Geräte bereits in diesem Netzwerk sind, prüfe, ob am Router **AP isolation**, **Client isolation** oder **Wireless isolation** aktiviert ist. Diese Einstellungen verhindern, dass Geräte einander erreichen.

Wenn du einen WLAN-Repeater verwendest, prüfe, ob er im **Access-Point-** oder **Bridge-Modus** arbeitet, statt ein eigenes Netzwerk anzulegen.

### 6. Wenn sich die Seite öffnet, der Beitritt aber dauert

Das Starten des Spiels für einen Spieler kann bis zu einer Minute dauern. Lass die Seite offen, solange die Fortschrittszeile unter **Beitreten…** die Phase wechselt.

Wenn ein Fehler erscheint, mache einen Screenshot oder kopiere den genauen Wortlaut einschließlich einer kleineren grauen Zeile.

Wenn die Seite ohne Fehler bei **Beitreten…** oder **Laden…** bleibt, nenne in deinem Kommentar die letzte Fortschrittsmeldung.

### 7. Wenn es vorher funktioniert hat

Die Adresse des Computers kann sich nach einer erneuten Netzwerkverbindung oder einem Router-Neustart geändert haben. Öffne den QR-Bildschirm und scanne erneut.

Wenn ein altes Lesezeichen oder eine Verknüpfung auf dem Startbildschirm nicht mehr funktioniert, ersetze es mit der neu gescannten Adresse.

---

## Noch immer Probleme? Schreibe in die Steam-Diskussion

Beginne in der [Steam-Diskussion](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) mit diesen Angaben:

- Wie weit es kommt: keine Seite, keine Spielerliste, Beitritt/Laden hängt oder Verbindung während des Spiels getrennt.
- Ein Screenshot oder die genaue Fehlermeldung.
- Das Betriebssystem des Computers sowie Handymodell und Browser.
- Ob alle Handys betroffen sind oder nur eines.

### Kopiere den Verbindungsbericht

Öffne auf dem Computer **Couch Co-Op-QR-Code** und schaue unter **Verbindungen** nach. Wähle unter **Verbindungsprobleme** die fehlgeschlagene Verbindung, dann **Bericht kopieren**, und füge den Bericht in deinen Kommentar ein.

Wenn dort keine Verbindung erscheint, erwähne das und gib die Informationen von oben an.

Der Bericht enthält die Pfade zu den passenden Logdateien. Falls Logs benötigt werden, erklärt [Du hast ein Problem? Melde es in der Steam-Diskussion](reporting-a-problem.md), wie du sie findest. Entferne vor dem öffentlichen Posten deine Steam-Konto-ID und den Benutzernamen deines Computers, wenn du sie privat halten möchtest.

Verwende die Mod in einem vertrauenswürdigen Netzwerk: Jeder, der die Beitrittsadresse erreichen kann, kann den Client öffnen und mitspielen.
