# Hai un problema? Scrivilo nella discussione di Steam

> Questa è una traduzione della discussione del Workshop di Steam [Having a problem? Post it here](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/). Per fare una domanda o segnalare un problema, lascia un commento in quella discussione: non serve scrivere in inglese, puoi scrivere in italiano.

Scrivi nella [discussione di Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243120957/) se qualcosa va storto: un crash, un giocatore che non riesce a finire di unirsi, qualcosa visualizzato male, una partita che smette di funzionare.

**Se il telefono o il tablet non riesce proprio ad aprire la pagina per unirsi alla partita**, leggi prima [Non riesci a connetterti da un telefono o un tablet?](phone-connection-troubleshooting.md). La maggior parte dei problemi di connessione dipende da un'impostazione del Wi-Fi, del firewall o del router trattata in quella guida.

### Prima di segnalare un blocco mentre ti unisci alla partita

Avviare il gioco di un giocatore può richiedere fino a un minuto, soprattutto su un computer più lento. Finché la riga sotto **Unione in corso…** nella pagina per unirsi continua a contare e a cambiare, il caricamento è ancora in corso: lascia la pagina aperta.

---

## Cosa includere

Non serve rispondere a tutto. I primi due punti sono i più utili.

### 1. Cosa è successo e cosa ti aspettavi

Bastano una o due frasi. Se è apparso un errore, copialo esattamente, compresa la riga grigia più piccola sotto, oppure pubblica una cattura o una foto dello schermo.

### 2. Il rapporto di connessione (problemi mentre ti unisci o nella lobby)

*Salta questo punto se il problema è successo durante una partita.*

Sul computer, apri **Codice QR di Couch Co-Op**, poi guarda sotto **Connessioni**. Seleziona la connessione non riuscita sotto **Problemi di connessione**, scegli **Copia rapporto** e incollalo nel tuo commento.

Indica quale passaggio non è riuscito e quanto tempo ha richiesto ciascuno, include cosa pensa l'host sia andato storto ed elenca i percorsi dei file di log qui sotto.

### 3. I file di log

Se hai copiato il rapporto di connessione, contiene già i percorsi esatti.

**Il log del gioco**, sul computer dell'host:

- Windows: `%APPDATA%\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/logs/godot.log`

**I log dei giocatori.** Ogni giocatore che si unisce esegue la propria copia nascosta del gioco sul computer dell'host, con il proprio log. Se un giocatore è rimasto bloccato mentre si univa, il suo log di solito spiega perché; quello del gioco, di solito, no.

Il primo giocatore che si unisce è `slot-2`, il successivo `slot-3` e così via. Per `slot-2`:

- Windows: `%APPDATA%\SlayTheSpire2\couch-coop\headless-slots\slot-2\SlayTheSpire2\logs\godot.log`
- Linux: `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log`
- macOS: `~/Library/Application Support/SlayTheSpire2/couch-coop/headless-slots/slot-2/Library/Application Support/SlayTheSpire2/logs/godot.log`

Se non c'è una cartella `headless-slots`, il log è `couch-coop/seat-logs/slot-2.log`, nella stessa cartella `SlayTheSpire2` del log del gioco.

**Quali righe contano.** In entrambi i log, le righe che mi servono di più sono quelle che contengono `[couchcoop]` (per esempio `[INFO] [couchcoop] ...`), più qualsiasi riga `[ERROR]`, anche se non menziona couchcoop. Di solito bastano queste.

**Prima di incollare un log intero:** questa discussione è pubblica. Un log contiene il tuo SteamID64 (un numero lungo che inizia con 7656 e rimanda al tuo profilo Steam) e il nome utente del tuo computer nei percorsi dei file. Non contiene password o account di altri giocatori. Se preferisci non condividere questi due dati, sostituiscili prima di incollare, oppure pubblica solo le righe `[couchcoop]` e `[ERROR]`: se mi serve altro, te lo chiederò.

### 4. Versioni e mod

- Se sei sul ramo **stabile** o sul ramo **beta pubblica** del gioco.
- **Le altre mod che hai installato.** La copia del gioco di ogni giocatore carica le stesse mod dell'host, quindi un'altra mod può impedire a un giocatore di unirsi anche quando il gioco dell'host funziona bene.
- Il sistema operativo dell'host.
- La tua versione di CouchCoop, se la conosci. Altrimenti darò per scontato che sia l'ultima.

### 5. Qualsiasi cosa aiuti a restringere il campo

- Succede ogni volta o solo a volte?
- Succede a tutti i giocatori o solo a uno?
- Prima funzionava? È cambiato qualcosa da allora, come un aggiornamento del gioco o una nuova mod?
