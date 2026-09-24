# Nie możesz połączyć się z telefonu lub tabletu?

> To jest tłumaczenie dyskusji w Warsztacie Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Aby zadać pytanie lub zgłosić problem, zostaw komentarz w tamtej dyskusji — nie musisz pisać po angielsku, możesz pisać po polsku.

Większość problemów z połączeniem sprowadza się do kilku przyczyn. Ta lista jest ułożona mniej więcej od najczęstszych do najrzadszych, więc warto iść po kolei.

*Jeśli twój telefon bez problemu otwiera stronę dołączania, a kłopot leży gdzie indziej - awaria, gracz, który nigdy nie kończy dołączania, coś nie tak w samej grze - zajrzyj zamiast tego do [Masz problem? Napisz o nim w dyskusji na Steamie](reporting-a-problem.md).*

---

## Co warto wypróbować

### 1. Wybierz inny adres na ekranie kodu QR

Ekran kodu QR ma przełącznik z kilkoma sposobami połączenia z hostem. Jeśli zeskanowany adres nie działa, wybierz inny i zeskanuj go ponownie.

Najlepiej wybierz zwykły adres numeryczny (coś w rodzaju **192.168.1.5:13337**). Ma najmniej elementów, które mogą zawieść. Nazwa **.local** i link internetowy zależą od rzeczy spoza modyfikacji - twojego routera, połączenia z internetem, uprawnień przeglądarki - więc mogą nie działać w sieci, w której adres numeryczny działa bez zarzutu.

**Na iPhonie lub iPadzie całkowicie pomiń wiersz *Link internetowy*.** Safari - i każda inna przeglądarka na iOS, bo pod spodem wszystkie są Safari - nie pozwala stronie wczytanej z internetu łączyć się z czymkolwiek w twojej sieci domowej. To zasada przeglądarki, a nie ustawienie, więc nie ma na co zezwalać ani czego zmieniać: strona się wczyta, a potem poinformuje, że gra nie odpowiedziała - w każdej sieci i niezależnie od ustawień zapory. Na iPhonie lub iPadzie używaj opcji **Zwykły adres** lub **Bezpieczny link**. (Strona sama o tym teraz mówi, jeśli do tego dojdziesz.)

### 2. Upewnij się, że telefon naprawdę jest w tej samej sieci

- Ta sama sieć Wi-Fi co komputer hosta, a nie sieć **dla gości**. Sieci dla gości zwykle blokują komunikację między urządzeniami, a właśnie tego tu potrzeba.
- Nie na danych mobilnych. Jeśli Wi-Fi nie ma dostępu do internetu, telefony czasem same przełączają się na dane mobilne, nic ci nie mówiąc.
- **Wyłącz na telefonie wszelkie VPN-y.** Na tym potyka się wiele osób. Liczą się też blokery reklam i aplikacje „prywatnego DNS”, które działają jako VPN.

### 3. Czytaj, co strona pokazuje podczas dołączania

Uruchomienie gry gracza może potrwać nawet minutę i jest to normalne, a nie usterka. W tym czasie strona pokazuje teraz, na jakim jest etapie, w wierszu pod napisem *Dołączanie…*:

*Łączenie z hostem — krok 1 z 6, minęło 14 s. Może to potrwać nawet minutę, więc nie zamykaj tej strony.*

Jeśli licznik sekund w tym wierszu rośnie, a etapy się zmieniają, wszystko działa - nie zamykaj strony. Sześć etapów to: „Łączenie z hostem”, „Oczekiwanie na hosta”, „Uruchamianie gry tego gracza”, „Dołączanie tego gracza do gry”, „Wczytywanie widoku gry” i „Już prawie gotowe”.

### 4. Jeśli się zatrzyma, strona mówi teraz DLACZEGO

Gdy coś naprawdę pójdzie nie tak, twoje urządzenie dowiaduje się, która z kilku niezwiązanych ze sobą przyczyn za tym stoi - w dwóch zdaniach oraz szarym wierszu technicznym. **Dołącz to wszystko do każdego zgłoszenia.** Możesz dostać jeden z trzech komunikatów, a każdy wymaga zupełnie innego rozwiązania:

- „**Twoja gra działa na komputerze hosta, ale to urządzenie nie mogło się z nią połączyć.**”\
  Chodzi o ścieżkę sieciową między twoim telefonem a hostem - sieć Wi-Fi dla gości, VPN albo router, który izoluje urządzenia od siebie. Z grą na hoście wszystko jest w porządku. Zobacz sekcje 2 i 6.
- „**Inny program na komputerze hosta używa portu, którego potrzebuje twoja gra.**”\
  Na twoim urządzeniu nic nie trzeba zmieniać. Na hoście coś innego zajmuje jeden z portów potrzebnych każdemu graczowi - najczęściej pozostały proces gracza z wcześniejszej sesji. Osoba, która hostuje, powinna go zamknąć (ponowne uruchomienie Slay the Spire 2 to naprawia).
- „**Komputer hosta blokuje port, na którym udostępniana jest twoja gra.**”\
  Tu również nic nie trzeba zmieniać na twoim urządzeniu. Blokuje go zapora lub oprogramowanie zabezpieczające samego hosta - zobacz sekcję 5.

**Najczęstszy przypadek blokady w ogóle nie pokazuje napisu *Dołączanie…*.** Jeśli twoje urządzenie dotarło do hosta, ale nie może połączyć się z portem przydzielonym twojemu graczowi, dołączenie się *udaje* - a strona przełącza się potem na *Wczytywanie…* i na tym utyka. Na tym ekranie nie ma wiersza postępu ani odliczania, bo z punktu widzenia hosta nic nie zawiodło. Pierwszą przydatną rzeczą, jaką zobaczysz, będzie powyższy komunikat „**nie mogło się z nią połączyć**”, około **20 sekund** po zmianie strony. Jeśli więc strona utknęła na *Wczytywanie…*, poczekaj pół minuty na ten komunikat zamiast odświeżać - odświeżenie rozpoczyna całe czekanie od nowa.

Jeśli natomiast strona stoi na *Dołączanie…* i nic się nie zmienia, host poddaje się po 75 sekundach z komunikatem „*Nie udało się uruchomić twojego widoku gry — spróbuj ponownie.*” i szarym wierszem pod nim. To inna awaria niż ta opisana wyżej. Tak czy inaczej, skopiuj to, co jest napisane.

### 5. Każdy gracz używa własnego portu

Lobby działa na porcie **13337**, a potem każdy gracz używa portu **13357**, **13367**, **13377** i tak dalej. Reguła zapory, która otwiera tylko 13337, pozwoli dotrzeć do listy graczy, a potem zawiedzie przy drugim kroku. Jeśli dodano taką regułę (samodzielnie albo według jakiegoś poradnika), usuń ją i zamiast tego zezwól na **program gry** - to obejmuje wszystkie porty, których potrzebuje.

### 6. Windows: zezwól grze na dostęp przez zaporę

Najpierw sprawdź typ sieci, bo już samo to blokuje wiele połączeń:

- **Ustawienia > Sieć i Internet > Wi-Fi** (lub Ethernet) > kliknij swoją sieć > ustaw **Typ profilu sieci** na **Sieć prywatna**.

Następnie zezwól na grę:

- **Ustawienia > Prywatność i zabezpieczenia > Zabezpieczenia Windows > Zapora i ochrona sieci > Zezwalaj aplikacji na dostęp przez zaporę**
- Znajdź na liście **Slay the Spire 2** i upewnij się, że pole **Prywatna** jest zaznaczone. Jeśli gry nie ma na liście, użyj opcji **Zezwalaj innej aplikacji...** i wskaż plik `.exe` gry.

Jeśli kiedyś w okienku zapory Windows kliknięto „Anuluj”, Windows zapamiętuje to jako regułę blokowania i już nigdy nie zapyta. W takim przypadku musisz usunąć powyższy wpis i dodać go ponownie.

**Otwarcie adresu w przeglądarce na samym komputerze hosta niczego nie dowodzi.** To oczywisty pomysł, ale pomiary pokazują, że wprowadza w błąd: Windows nie filtruje ruchu komputera do samego siebie - nawet do jego własnego adresu sieciowego - więc nawet gdy zapora aktywnie blokuje każdy telefon, przeglądarka na hoście i tak bez problemu wczyta stronę. Jeśli u ciebie to zadziałało, wiesz tylko tyle, że gra działa i udostępnia stronę. O zaporze nie mówi to absolutnie nic.

Zaznaczaj **Publiczna** tylko wtedy, gdy twoja sieć jest ustawiona jako publiczna i nie możesz tego zmienić. Zaznaczenie tego pola sprawia, że gra jest dostępna w każdej sieci, do której się podłączysz, także w kawiarniach i hotelach.

### 7. Router

Niektóre routery nie pozwalają urządzeniom w tej samej sieci Wi-Fi łączyć się ze sobą. Poszukaj ustawienia o nazwie **AP isolation**, **Client isolation** lub **Wireless isolation** (po polsku często „izolacja AP”) i je wyłącz.

Warto też wiedzieć: wzmacniacz Wi-Fi lub adapter PLC (powerline) skonfigurowany w trybie **routera** zamiast w trybie **mostu** (bridge) / **punktu dostępowego** (access point) umieszcza twój telefon w innej sieci niż host, nawet jeśli nazwa Wi-Fi wygląda tak samo.

### 8. Ustawienia przeglądarki, które blokują zwykłe adresy

Niektóre przeglądarki próbują wymuszać HTTPS dla każdego adresu, a zwykły adres numeryczny z niego nie korzysta. (Korzysta z niego wiersz **Bezpieczny link** na ekranie kodu QR - więc jeśli problemem jest wymuszanie HTTPS, warto spróbować także tego wiersza.) Jeśli pasek adresu zamiast gry pokazuje ostrzeżenie o bezpieczeństwie, wyłącz te opcje i spróbuj ponownie:

- Chrome: **Ustawienia > Prywatność i bezpieczeństwo > Bezpieczeństwo > Zawsze używaj bezpiecznych połączeń**
- Firefox: **Ustawienia > Prywatność i bezpieczeństwo > Bezpieczeństwo połączeń i oprogramowania > Ustawienia zaawansowane > Tryb używania wyłącznie protokołu HTTPS**

Na iPhonie sprawdź też **Ustawienia > *Twoje imię i nazwisko* > iCloud > Przekazywanie prywatne**, a także opcję „Ukrywaj adres IP” w **Ustawienia > Aplikacje > Safari**.

### 9. Antywirus z własną zaporą

Pakiety zabezpieczające, takie jak ESET, Bitdefender, Norton, Kaspersky i Avast, mają własną zaporę, oddzielną od zapory Windows. Zezwolenie na grę w Windows nic dla nich nie zmienia. Sprawdź ustawienia sieci lub zapory w samym pakiecie albo na chwilę wstrzymaj jego zaporę, żeby zobaczyć, czy to ona blokuje połączenie.

### 10. Jeśli wcześniej działało, a potem przestało

Adres komputera hosta może się zmienić, gdy ponownie łączy się z Wi-Fi lub po restarcie routera. Otwórz ponownie ekran kodu QR i zeskanuj kod jeszcze raz - znajdziesz tam nowy adres.

Jeśli klient został dodany do ekranu głównego, dalszy ciąg zależy od tego, z którego wiersza go zainstalowano:

- Zainstalowany z wiersza **Link internetowy**: dalej działa i sam znajduje nowy adres. Po prostu go otwórz - ponowne skanowanie nie jest potrzebne.
- Zainstalowany z **adresu numerycznego** lub z wiersza **Bezpieczny link**: ikona wskazuje stary adres i nie potrafi się naprawić. Usuń ją i dodaj ponownie po ponownym zeskanowaniu kodu. (Na Androidzie instalacja z wiersza **Link internetowy** raz na zawsze pozwala tego uniknąć. Na iPhonie lub iPadzie ten wiersz nie może działać - zobacz sekcję 1 - więc tam jedynym wyjściem jest ponowne dodanie ikony.)

---

## Nadal nie działa? Napisz komentarz w dyskusji na Steamie

Zostaw komentarz w [dyskusji na Steamie](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) - nie musisz odpowiadać na wszystko. Nawet jedna czy dwie z tych informacji bardzo ułatwiają zajęcie się zgłoszeniem, a pierwsze pytanie jest warte więcej niż wszystkie pozostałe razem wzięte.

### Na którym etapie się zatrzymuje?

To najbardziej przydatna rzecz, jaką możesz mi przekazać, bo każda odpowiedź wskazuje na inną przyczynę:

- przeglądarka w ogóle niczego nie wczytuje
- strona się wczytuje, ale lista graczy nigdy się nie pojawia
- możesz wybrać nazwę, ale wszystko stoi na „Dołączanie…” - napisz mi, co pokazywał wiersz postępu pod spodem i jaki komunikat pojawił się po odczekaniu
- udaje się przejść dalej, ale zamiast tego wszystko stoi na „**Wczytywanie…**” - to przypadek portu/zapory i jest najczęstszy. Napisz mi, czy po około 20 sekundach pojawił się komunikat „nie mogło się z nią połączyć”
- połączenie działało, a potem zerwało się w trakcie rozgrywki

### Co jeszcze możesz dodać

- Dokładny komunikat wyświetlany przez telefon, razem z szarym wierszem pod nim. Zdjęcie ekranu będzie idealne.
- Który adres zeskanowano - numeryczny, nazwę **.local** czy link internetowy.
- System operacyjny hosta oraz model i przeglądarka telefonu/tabletu.
- Czy nie działa na **każdym** urządzeniu, czy tylko na jednym? Jeśli jeden telefon działa, a inny nie, to wyklucza wiele przyczyn.
- Czy kiedykolwiek wcześniej działało i czy od tego czasu coś się zmieniło?
- Host na Wi-Fi czy przez Ethernet. Czy na hoście lub telefonie działa jakiś VPN. Czy jest antywirus z zaporą.

### Trzy rzeczy, które może dać ci komputer hosta

- **Panel połączeń.** Na hoście otwórz ekran **Kod QR Couch Co-Op** - pod kodem znajduje się panel **Połączenia**. Wymienione są w nim urządzenia, które dotarły na tyle daleko, żeby się tam pojawić, a wszystko, co poszło nie tak, trafia pod **Problemy z połączeniem** (z liczbą obok). Zaznacz wiersz i użyj **Skopiuj raport** - skopiujesz w ten sposób raport, który zawiera już krok, na którym wystąpił błąd, czasy i diagnozę samego hosta. Wklej go od razu do swojego komentarza. Raport podaje też dokładną ścieżkę obu poniższych plików logu, więc nie musisz ich szukać.
- **Główny plik logu.** W Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`. W Linuksie: `~/.local/share/SlayTheSpire2/logs/godot.log`. W macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **Log każdego gracza.** Każdy dołączający gracz dostaje własną kopię gry działającą w tle na hoście i każda z nich prowadzi własny log. **Jeśli strona doszła do napisu *Dołączanie…*, a potem upłynął limit czasu, to właśnie ten plik wyjaśnia dlaczego** - powyższy główny log zwykle tego nie robi. Gracze są numerowani od 2, więc pierwsza osoba, która dołącza, to `slot-2`: w Linuksie jest to `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` (tak, `SlayTheSpire2` dwa razy - to nie literówka), a ścieżki w Windows i macOS mają ten sam układ w ich folderach podanych wyżej. W niektórych konfiguracjach jest to zamiast tego pojedynczy plik `couch-coop/seat-logs/slot-2.log`.

**Które wiersze są ważne.** W obu logach przydatne są te, które zawierają `[couchcoop]` - wyglądają jak `[INFO] [couchcoop] ...` - oraz wszystkie wiersze `[ERROR]`, nawet te, które nie wspominają o couchcoop. Zwykle same w sobie wystarczą.

**Zanim wkleisz cały log:** dyskusja na Steamie jest publiczna, a log zawiera twój własny **SteamID64** (długą liczbę zaczynającą się od 7656, która wskazuje na twój profil Steam) i **nazwę użytkownika** twojego komputera w ścieżkach plików. *Nie* zawiera haseł ani kont innych graczy - tylko twoje. Jeśli wolisz tego nie publikować, wystarczy przed wklejeniem użyć funkcji „znajdź i zamień” na tych dwóch rzeczach albo po prostu wkleić tylko wiersze `[couchcoop]` i `[ERROR]` - jeśli będę potrzebować więcej, zapytam.

---

Na koniec jeszcze jedno: każdy, kto może dotrzeć do adresu dołączania, może otworzyć klienta i grać, więc używaj tego w sieci, której ufasz.
