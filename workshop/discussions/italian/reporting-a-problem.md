# Hai un problema? Scrivilo nella discussione di Steam

> Questa è una traduzione della discussione del Workshop di Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Per fare una domanda o segnalare un problema, lascia un commento in quella discussione: non serve scrivere in inglese, puoi scrivere in italiano.

La [discussione di Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) è il posto giusto per qualsiasi cosa vada storta: crash, un giocatore che non finisce mai di unirsi, qualcosa visualizzato in modo errato, una partita che si rompe.

**Se il telefono o il tablet non riesce proprio a raggiungere la pagina per unirsi alla partita**, leggi prima [Non riesci a connetterti da un telefono o un tablet?](phone-connection-troubleshooting.md): tratta nel dettaglio Wi-Fi, firewall e router, e lì si risolve la maggior parte dei problemi di connessione.

---

## Cosa includere

Non serve rispondere a tutto: i primi due punti valgono più di tutto il resto messo insieme.

### 1. Cosa è successo, e cosa ti aspettavi invece

Bastano una o due frasi. Se sullo schermo c'era un messaggio di errore, riportalo esattamente, compresa l'eventuale riga grigia più piccola sotto. Una foto o uno screenshot sono perfetti.

### 2. Se il problema riguarda l'ingresso nella partita o la lobby: il rapporto di connessione

*Se il problema si presenta più tardi - durante una partita o nel gioco stesso - passa direttamente al punto 3.*

Dalla lobby, apri la schermata **Codice QR di Couch Co-Op**. Il pannello **Connessioni** si trova lì, sotto il codice. Tutto ciò che è andato storto viene conservato sotto **Problemi di connessione** (seguito da un numero).

Seleziona la riga che ha avuto il problema e premi **Copia rapporto**, poi incollalo nel tuo commento. Per un problema di ingresso è in assoluto la cosa più utile che puoi allegare: contiene già il passaggio fallito, i tempi, la diagnosi dell'host stesso e i percorsi dei file di log descritti sotto.

### 3. I file di log

Ce ne sono di due tipi, e quale conta dipende dal problema.

**Il log principale del gioco**, sul computer host:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**Il log di ogni giocatore.** Ogni giocatore che si unisce ottiene una propria copia del gioco in esecuzione in background sul computer host, e ognuna tiene il proprio log. **Se un giocatore è rimasto bloccato mentre si univa, è questo il file che spiega perché** - il log principale qui sopra di solito no.

I giocatori sono numerati a partire da 2, quindi la prima persona che si unisce a te è `slot-2`. Su Linux il log di quel giocatore si trova in:

`~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`

(Sì, `SlayTheSpire2` compare davvero due volte: non è un errore di battitura.) Su Windows e macOS la struttura è la stessa, sotto la cartella dell'elenco qui sopra. In alcune configurazioni, invece, è un unico file in `couch-coop/seat-logs/slot-2.log`. In ogni caso, **il rapporto del punto 2 indica il percorso esatto**, quindi copiarlo per primo ti evita di cercare.

**Quali righe contano.** In entrambi i file, quelle utili contengono `[couchcoop]` - hanno un aspetto come `[INFO] [couchcoop] ...` - più tutte le righe `[ERROR]`, anche quelle che non menzionano couchcoop. Di solito queste righe bastano da sole.

**Prima di incollare un log intero:** la discussione di Steam è pubblica, e un log contiene il tuo **SteamID64** (un numero lungo che inizia con 7656 e rimanda al tuo profilo Steam) e il **nome utente** del tuo computer, nei percorsi dei file. *Non* contiene password, e non contiene gli account degli altri giocatori, solo il tuo. Se preferisci non pubblicarli, basta un trova e sostituisci su questi due dati prima di incollare, oppure pubblica solo le righe `[couchcoop]` e `[ERROR]`: se mi serve altro, te lo chiederò.

### 4. Versioni e mod

- Se sei sul ramo **stabile** o sul ramo **beta pubblica** del gioco.
- **Quali altre mod sono installate.** Ogni copia di un giocatore in background carica le stesse mod dell'host, quindi un'altra mod può impedire a un giocatore di finire di unirsi anche quando il gioco dell'host sembra funzionare perfettamente.
- Sistema operativo dell'host.
- La versione di CouchCoop, se la conosci; altrimenti darò per scontato che sia l'ultima.

### 5. Qualsiasi cosa aiuti a restringere il campo

- Succede ogni volta o solo a volte?
- Succede a tutti i giocatori o solo a uno?
- Ha mai funzionato prima, ed è cambiato qualcosa da allora: un aggiornamento del gioco, una nuova mod?

---

## Una cosa da sapere prima di segnalare

Avviare la partita di un giocatore può richiedere fino a un minuto, e su una macchina più lenta ne userà la maggior parte. È normale, non è un guasto. Mentre è in corso, la pagina per unirsi conta i secondi e cambia fase sotto *Unione alla partita…*: se quella riga si muove ancora, non è andato storto niente, quindi tieni aperta la pagina.
