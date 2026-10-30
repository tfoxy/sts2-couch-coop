# Nie możesz połączyć się z telefonu lub tabletu?

> To jest tłumaczenie dyskusji w Warsztacie Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Aby zadać pytanie lub zgłosić problem, zostaw komentarz w tamtej dyskusji — nie musisz pisać po angielsku, możesz pisać po polsku.

Wypróbuj te kroki, jeśli telefon lub tablet nie może się połączyć. W przypadku awarii lub problemów podczas rozgrywki zajrzyj do [Masz problem? Opisz go w dyskusji na Steam](reporting-a-problem.md).

### 1. Wybierz ustawienia połączenia

Na komputerze, na którym działa gra, otwórz **Kod QR Couch Co-Op**.

- **Interfejs sieciowy** (po lewej): wybierz **Przewodowy (Ethernet)**, jeśli komputer łączy się z routerem kablem, lub **Wi-Fi**, jeśli łączy się bezprzewodowo. Wybierz połączenie z routerem, z którego korzysta telefon. Pomiń **Nazwa komputera (.local)**.
- **Metoda połączenia** (po prawej): wybierz **Adres bezpośredni**, bez „(HTTPS)”. Adres powinien zaczynać się od `http://`, na przykład `http://192.168.1.5:13337`.

Po zmianie tych ustawień zeskanuj kod QR ponownie.

Podczas rozwiązywania problemu używaj opcji **Adres bezpośredni**. Metody HTTPS to dodatkowe opcje poprawiające wydajność i bezpieczeństwo, wymagające dodatkowej konfiguracji lub spełnienia warunków połączenia.

### 2. Sprawdź sieć telefonu

- Połącz telefon z domowym Wi-Fi, a nie z siecią **gościnną**. Komputer może korzystać z Wi-Fi lub kabla do tego samego routera.
- Upewnij się, że telefon korzysta z Wi-Fi zamiast z danych komórkowych.
- Tymczasowo rozłącz VPN na telefonie lub komputerze. Dotyczy to też blokerów reklam na telefonie, które używają połączenia VPN.

**Jeśli strona się otwiera, ale dołączanie się zatrzymuje, przejdź do kroku 6.**

### 3. Windows: zezwól grze na dostęp przez zaporę

W swojej sieci domowej:

1. **Ustawienia > Sieć i Internet > Wi-Fi** (lub Ethernet) > kliknij swoją sieć > ustaw **Typ profilu sieci** na **Sieć prywatna**.
2. **Ustawienia > Prywatność i zabezpieczenia > Zabezpieczenia Windows > Zapora i ochrona sieci > Zezwalaj aplikacji na dostęp przez zaporę**
3. Znajdź na liście **Slay the Spire 2** i upewnij się, że pole **Prywatna** jest zaznaczone. Jeśli gry nie ma na liście, użyj opcji **Zezwalaj innej aplikacji...** i wskaż plik `.exe` gry.

Jeśli wcześniej anulowano monit zapory dotyczący gry, usuń jej zablokowany wpis i dodaj grę ponownie.

Jeśli antywirus ma własną zaporę, zezwól na grę również w niej.

Otwarcie adresu na komputerze, na którym działa gra, nie sprawdza, czy zapora pozwala telefonowi się połączyć.

### 4. Sprawdź, czy przeglądarka wymusza HTTPS

Metoda **Adres bezpośredni** używa `http://`. Jeśli przeglądarka próbuje zmienić to na `https://`, sprawdź ustawienie bezpiecznych połączeń:

- Chrome: **Ustawienia > Prywatność i bezpieczeństwo > Bezpieczeństwo > Zawsze używaj bezpiecznych połączeń**
- Firefox: **Ustawienia > Prywatność i bezpieczeństwo > Bezpieczeństwo połączeń i oprogramowania > Ustawienia zaawansowane > Tryb używania wyłącznie protokołu HTTPS**

Zezwól na adres HTTP, a następnie ponownie zeskanuj kod QR. Na komputerze pozostaw wybraną opcję **Adres bezpośredni**.

### 5. Sprawdź router

Gościnne Wi-Fi często uniemożliwia urządzeniom komunikację ze sobą. Użyj głównej sieci domowej.

Jeśli oba urządzenia są już w tej sieci, sprawdź, czy router ma włączone **AP isolation**, **Client isolation** lub **Wireless isolation**. Te ustawienia blokują komunikację między urządzeniami.

Jeśli używasz wzmacniacza Wi-Fi, sprawdź, czy działa w trybie **punktu dostępu** (access point) lub **mostu** (bridge), zamiast tworzyć osobną sieć.

### 6. Jeśli strona się otwiera, ale dołączanie trwa dłużej

Uruchomienie gry dla gracza może potrwać do minuty. Pozostaw stronę otwartą, dopóki wiersz postępu pod **Dołączanie…** zmienia etap.

Jeśli pojawi się błąd, zrób zrzut ekranu lub skopiuj dokładną treść, łącznie z ewentualnym mniejszym szarym wierszem.

Jeśli strona pozostaje na **Dołączanie…** lub **Wczytywanie…** bez błędu, podaj ostatni komunikat postępu w swoim komentarzu.

### 7. Jeśli wcześniej działało

Adres komputera mógł się zmienić po ponownym połączeniu z siecią lub restarcie routera. Otwórz ekran kodu QR i zeskanuj go ponownie.

Jeśli stara zakładka lub skrót na ekranie głównym już nie działa, zastąp je nowo zeskanowanym adresem.

---

## Nadal nie działa? Napisz w dyskusji na Steam

W [dyskusji na Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) zacznij od tych informacji:

- Jak daleko dochodzi: brak strony, brak listy graczy, zatrzymane dołączanie/wczytywanie lub rozłączenie podczas gry.
- Zrzut ekranu lub dokładny komunikat błędu.
- System operacyjny komputera, model telefonu i przeglądarka.
- Czy problem występuje na wszystkich telefonach, czy tylko na jednym.

### Skopiuj raport połączenia

Na komputerze otwórz **Kod QR Couch Co-Op** i sprawdź panel **Połączenia**. Wybierz nieudane połączenie w **Problemy z połączeniem**, użyj **Skopiuj raport** i wklej raport do komentarza.

Jeśli nie ma tam żadnego połączenia, napisz o tym i podaj informacje wymienione powyżej.

Raport zawiera ścieżki do odpowiednich plików dziennika. Jeśli dzienniki będą potrzebne, [Masz problem? Opisz go w dyskusji na Steam](reporting-a-problem.md) wyjaśnia, jak je znaleźć. Przed publicznym zamieszczeniem dzienników usuń identyfikator swojego konta Steam i nazwę użytkownika komputera, jeśli chcesz zachować je dla siebie.

Używaj moda w zaufanej sieci: każdy, kto może otworzyć adres dołączania, może uruchomić klienta i grać.
