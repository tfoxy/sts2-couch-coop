# Masz problem? Napisz o nim w dyskusji na Steamie

> To jest tłumaczenie dyskusji w Warsztacie Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Aby zadać pytanie lub zgłosić problem, zostaw komentarz w tamtej dyskusji — nie musisz pisać po angielsku, możesz pisać po polsku.

Napisz w [dyskusji na Steamie](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/), jeśli coś pójdzie nie tak: gra się zamknie, gracz nie może dokończyć dołączania, coś źle się wyświetla lub rozgrywka przestaje działać.

**Jeśli twój telefon lub tablet w ogóle nie może otworzyć strony dołączania**, najpierw przeczytaj [Nie możesz połączyć się z telefonu lub tabletu?](phone-connection-troubleshooting.md). Większość problemów z połączeniem wynika z ustawień Wi-Fi, zapory lub routera opisanych w tym poradniku.

### Zanim zgłosisz zablokowane dołączanie

Uruchomienie gry gracza może potrwać nawet minutę, zwłaszcza na wolniejszym komputerze. Dopóki wiersz pod napisem **Dołączanie…** na stronie dołączania nadal nalicza czas i się zmienia, uruchamianie trwa, więc nie zamykaj strony.

---

## Co warto podać

Nie musisz odpowiadać na wszystko. Dwa pierwsze punkty pomagają najbardziej.

### 1. Co się stało i jaki był oczekiwany efekt

Wystarczą jedno lub dwa zdania. Jeśli pojawił się błąd, skopiuj go dokładnie, razem z mniejszym szarym wierszem pod nim, albo opublikuj zrzut lub zdjęcie ekranu.

### 2. Raport połączenia (problemy z dołączaniem lub w lobby)

*Pomiń ten punkt, jeśli problem wystąpił w trakcie rozgrywki.*

Na komputerze otwórz **Kod QR Couch Co-Op**, a potem odszukaj sekcję **Połączenia**. W sekcji **Problemy z połączeniem** wybierz nieudane połączenie, wybierz **Skopiuj raport** i wklej go do swojego komentarza.

Raport podaje, który krok się nie powiódł i ile czasu zajął każdy krok, zawiera ocenę hosta dotyczącą przyczyny problemu oraz ścieżki do opisanych poniżej plików logów.

### 3. Pliki logów

Skopiowany raport połączenia zawiera już dokładne ścieżki.

**Log gry** na komputerze hosta:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Logi graczy.** Każdy dołączający gracz uruchamia własną ukrytą kopię gry na komputerze hosta, z własnym logiem. Jeśli gracz utknął przy dołączaniu, jego log zwykle wyjaśnia dlaczego; log gry zwykle tego nie robi.

Pierwszy dołączający gracz to `slot-2`, następny to `slot-3` i tak dalej. Dla `slot-2`:

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

Jeśli nie ma folderu `headless-slots`, log znajduje się w `couch-coop/seat-logs/slot-2.log`, w tym samym folderze `SlayTheSpire2` co log gry.

**Które wiersze są ważne.** W obu logach najbardziej potrzebuję wierszy zawierających `[couchcoop]` (na przykład `[INFO] [couchcoop] ...`) oraz wszystkich wierszy `[ERROR]`, nawet tych, które nie wspominają o couchcoop. Zwykle to wystarczy.

**Zanim wkleisz cały log:** ta dyskusja jest publiczna. Log zawiera twój SteamID64 (długą liczbę zaczynającą się od 7656, która prowadzi do twojego profilu Steam) i nazwę użytkownika twojego komputera w ścieżkach plików. Nie zawiera haseł ani kont innych graczy. Jeśli wolisz nie udostępniać tych dwóch danych, zamień je przed wklejeniem albo opublikuj tylko wiersze `[couchcoop]` i `[ERROR]`, a jeśli będę potrzebować więcej, zapytam.

### 4. Wersje i modyfikacje

- Czy grasz na gałęzi **stabilnej**, czy na gałęzi **otwartej bety** gry.
- **Jakie inne modyfikacje masz zainstalowane.** Kopia gry każdego gracza wczytuje te same modyfikacje co host, więc inna modyfikacja może uniemożliwić graczowi dołączenie, nawet gdy gra hosta działa prawidłowo.
- System operacyjny hosta.
- Twoja wersja CouchCoop, jeśli ją znasz. W przeciwnym razie założę, że to najnowsza.

### 5. Wszystko, co pomaga zawęzić problem

- Czy dzieje się to za każdym razem, czy tylko czasami?
- Czy dotyczy każdego gracza, czy tylko jednego?
- Czy wcześniej działało i czy od tego czasu coś się zmieniło, na przykład aktualizacja gry lub nowa modyfikacja?
