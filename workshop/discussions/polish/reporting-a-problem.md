# Masz problem? Napisz o nim w dyskusji na Steamie

> To jest tłumaczenie dyskusji w Warsztacie Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Aby zadać pytanie lub zgłosić problem, zostaw komentarz w tamtej dyskusji — nie musisz pisać po angielsku, możesz pisać po polsku.

[Dyskusja na Steamie](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) to miejsce na wszystko, co idzie nie tak - awarie, gracz, który nigdy nie kończy dołączania, coś, co wyświetla się nieprawidłowo, rozgrywka, która się psuje.

**Jeśli twój telefon lub tablet w ogóle nie może otworzyć strony dołączania**, najpierw przeczytaj [Nie możesz połączyć się z telefonu lub tabletu?](phone-connection-troubleshooting.md) - omawia szczegółowo Wi-Fi, zapory i routery, a większość problemów z połączeniem da się tam rozwiązać.

---

## Co warto podać

Nie musisz odpowiadać na wszystko - dwa pierwsze punkty są warte więcej niż cała reszta razem wzięta.

### 1. Co się stało i co powinno było się stać zamiast tego

Wystarczą jedno lub dwa zdania. Jeśli na ekranie pojawił się komunikat o błędzie, przytocz go dokładnie, razem z mniejszym szarym wierszem pod nim, jeśli taki jest. Zdjęcie lub zrzut ekranu będą idealne.

### 2. Jeśli problem dotyczy dołączania lub lobby: raport połączenia

*Jeśli problem występuje później - w trakcie rozgrywki albo w samej grze - przejdź od razu do kroku 3.*

W lobby otwórz ekran **Kod QR do współpracy na kanapie**. Pod kodem znajduje się panel **Znajomości**. Wszystko, co poszło nie tak, trafia pod **Problemy z połączeniem** (z liczbą obok).

Zaznacz wiersz, który się nie powiódł, i naciśnij **Skopiuj raport**, a potem wklej raport do swojego komentarza. Przy problemie z dołączaniem to najbardziej przydatna rzecz, jaką możesz załączyć: zawiera już krok, na którym wystąpił błąd, czasy, diagnozę samego hosta i ścieżki do opisanych niżej plików logów.

### 3. Pliki logów

Są dwa rodzaje, a to, który jest ważny, zależy od problemu.

**Główny log gry** na komputerze hosta:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Log każdego gracza.** Każdy dołączający gracz dostaje własną kopię gry działającą w tle na komputerze hosta i każda z nich prowadzi własny log. **Jeśli gracz utknął przy dołączaniu, to właśnie ten plik wyjaśnia dlaczego** - powyższy główny log zwykle tego nie robi.

Gracze są numerowani od 2, więc pierwsza osoba, która do ciebie dołącza, to `slot-2`. W Linuksie log tego gracza znajduje się tutaj:

`~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`

(Tak, `SlayTheSpire2` naprawdę występuje dwa razy - to nie literówka.) W Windows i macOS układ jest taki sam, w folderze z listy powyżej. W niektórych konfiguracjach jest to zamiast tego pojedynczy plik `couch-coop/seat-logs/slot-2.log`. Tak czy inaczej, **raport z kroku 2 podaje dokładną ścieżkę**, więc skopiowanie go najpierw oszczędza szukania.

**Które wiersze są ważne.** W obu plikach przydatne są te, które zawierają `[couchcoop]` - wyglądają jak `[INFO] [couchcoop] ...` - oraz wszystkie wiersze `[ERROR]`, nawet te, które nie wspominają o couchcoop. Zwykle te wiersze same w sobie wystarczą.

**Zanim wkleisz cały log:** dyskusja na Steamie jest publiczna, a log zawiera twój własny **SteamID64** (długą liczbę zaczynającą się od 7656, która wskazuje na twój profil Steam) i **nazwę użytkownika** twojego komputera w ścieżkach plików. *Nie* zawiera haseł ani kont innych graczy - tylko twoje. Jeśli wolisz tego nie publikować, wystarczy przed wklejeniem użyć funkcji „znajdź i zamień” na tych dwóch rzeczach albo po prostu wkleić tylko wiersze `[couchcoop]` i `[ERROR]` - jeśli będę potrzebował więcej, zapytam.

### 4. Wersje i modyfikacje

- Czy grasz na gałęzi **stabilnej**, czy na gałęzi **otwartej bety** gry.
- **Jakie inne modyfikacje są zainstalowane.** Każda kopia gracza działająca w tle wczytuje te same modyfikacje co host, więc inna modyfikacja może uniemożliwić graczowi dokończenie dołączania, nawet gdy gra na hoście wygląda na całkowicie sprawną.
- System operacyjny hosta.
- Wersja CouchCoop, jeśli ją znasz - w przeciwnym razie założę, że to najnowsza.

### 5. Wszystko, co pomaga zawęzić problem

- Czy dzieje się to za każdym razem, czy tylko czasami?
- Czy dotyczy każdego gracza, czy tylko jednego?
- Czy kiedykolwiek wcześniej działało i czy od tego czasu coś się zmieniło - aktualizacja gry, nowa modyfikacja?

---

## Jedna rzecz, o której warto wiedzieć przed zgłoszeniem

Uruchomienie gry gracza może potrwać nawet minutę, a na wolniejszym komputerze zajmie większość tego czasu. To normalne, a nie usterka. W tym czasie strona dołączania nalicza sekundy i zmienia etapy pod napisem *Dołączam…* - jeśli ten wiersz wciąż się zmienia, nic jeszcze nie poszło źle, więc nie zamykaj strony.
