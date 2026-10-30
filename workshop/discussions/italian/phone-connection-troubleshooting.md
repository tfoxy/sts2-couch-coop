# Non riesci a connetterti da un telefono o un tablet?

> Questa è una traduzione della discussione del Workshop di Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Per fare una domanda o segnalare un problema, lascia un commento in quella discussione: non serve scrivere in inglese, puoi scrivere in italiano.

Prova questi passaggi se il telefono o il tablet non riesce a connettersi. Per arresti anomali o problemi durante una partita, consulta [Hai un problema? Segnalalo nella discussione Steam](reporting-a-problem.md).

### 1. Scegli le impostazioni di connessione

Sul computer che esegue il gioco, apri **Codice QR di Couch Co-Op**.

- **Interfaccia di rete** (a sinistra): scegli **Cablato (Ethernet)** se il computer è collegato al router con un cavo, oppure **Wi-Fi** se è collegato senza fili. Scegli la connessione al router usato dal telefono. Salta **Nome del PC (.local)**.
- **Metodo di connessione** (a destra): scegli **Indirizzo diretto**, senza “(HTTPS)”. L’indirizzo deve iniziare con `http://`, per esempio `http://192.168.1.5:13337`.

Scansiona di nuovo il codice QR dopo aver modificato queste impostazioni.

Usa **Indirizzo diretto** durante la risoluzione del problema. I metodi HTTPS sono opzioni per prestazioni e sicurezza, con configurazioni o requisiti di connessione aggiuntivi.

### 2. Controlla la rete del telefono

- Collega il telefono al Wi-Fi di casa, non alla rete **Ospiti**. Il computer può usare il Wi-Fi o un cavo verso lo stesso router.
- Assicurati che il telefono usi il Wi-Fi anziché i dati mobili.
- Disconnetti temporaneamente qualsiasi VPN sul telefono o sul computer. Contano anche le app per bloccare la pubblicità sul telefono che usano una connessione VPN.

**Se la pagina si apre ma l’ingresso nella partita rimane bloccato, passa al punto 6.**

### 3. Windows: consenti il gioco attraverso il firewall

Sulla tua rete domestica:

1. **Impostazioni > Rete e Internet > Wi-Fi** (o Ethernet) > fai clic sulla tua rete > imposta **Tipo di profilo di rete** su **Rete privata**.
2. **Impostazioni > Privacy e sicurezza > Sicurezza di Windows > Firewall e protezione rete > Consenti app tramite firewall**
3. Trova **Slay the Spire 2** nell'elenco e assicurati che **Privato** sia selezionato. Se non è nell'elenco, usa **Consenti un'altra app...** e cerca il file `.exe` del gioco.

Se in precedenza hai annullato la richiesta del firewall per il gioco, rimuovi la voce bloccata e aggiungi di nuovo il gioco.

Se l’antivirus ha un proprio firewall, consenti il gioco anche lì.

Aprire l’indirizzo sul computer che esegue il gioco non verifica se il firewall permette al telefono di connettersi.

### 4. Controlla se il browser forza HTTPS

Il metodo **Indirizzo diretto** usa `http://`. Se il browser tenta di cambiarlo in `https://`, controlla l’impostazione per le connessioni sicure:

- Chrome: **Impostazioni > Privacy e sicurezza > Sicurezza > Utilizza sempre connessioni sicure**
- Firefox: **Impostazioni > Privacy e sicurezza > Sicurezza connessione e software > Impostazioni avanzate > Modalità solo HTTPS**

Consenti l’indirizzo HTTP, poi scansiona di nuovo il codice QR. Mantieni **Indirizzo diretto** selezionato sul computer.

### 5. Controlla il router

Il Wi-Fi per ospiti spesso impedisce ai dispositivi di comunicare tra loro. Usa la rete principale di casa.

Se entrambi i dispositivi sono già su quella rete, controlla se sul router è attivo **AP isolation**, **Client isolation** o **Wireless isolation**. Queste impostazioni impediscono ai dispositivi di comunicare tra loro.

Se usi un ripetitore Wi-Fi, verifica che sia in modalità **access point** o **bridge**, anziché creare una rete separata.

### 6. Se la pagina si apre ma l’ingresso nella partita richiede tempo

Avviare la partita di un giocatore può richiedere fino a un minuto. Tieni aperta la pagina mentre la riga di avanzamento sotto **Unione in corso…** cambia fase.

Se compare un errore, fai uno screenshot o copia il testo esatto, compresa l’eventuale riga grigia più piccola.

Se rimane su **Unione in corso…** o **Caricamento…** senza errori, includi l’ultimo messaggio di avanzamento nel tuo commento.

### 7. Se prima funzionava

L’indirizzo del computer potrebbe essere cambiato dopo una riconnessione alla rete o un riavvio del router. Apri la schermata del codice QR e scansionalo di nuovo.

Se un vecchio segnalibro o collegamento nella schermata iniziale non funziona più, sostituiscilo usando l’indirizzo appena scansionato.

---

## Ancora bloccato? Commenta nella discussione Steam

Nella [discussione Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/), inizia con:

- Fin dove arriva: nessuna pagina, nessun elenco dei giocatori, ingresso o caricamento bloccato, oppure disconnessione durante la partita.
- Uno screenshot o il messaggio di errore esatto.
- Il sistema operativo del computer, il modello del telefono e il browser.
- Se il problema riguarda tutti i telefoni o solo uno.

### Copia il rapporto di connessione

Sul computer, apri **Codice QR di Couch Co-Op**, poi guarda sotto **Connessioni**. Seleziona la connessione non riuscita sotto **Problemi di connessione**, scegli **Copia rapporto** e incolla il rapporto nel tuo commento.

Se non compare alcuna connessione, dillo e pubblica le informazioni elencate sopra.

Il rapporto include i percorsi dei file di log pertinenti. Se servono i log, [Hai un problema? Segnalalo nella discussione Steam](reporting-a-problem.md) spiega come trovarli. Prima di pubblicare i log, rimuovi l’ID del tuo account Steam e il nome utente del computer se preferisci mantenerli privati.

Usa il mod su una rete fidata: chiunque possa raggiungere l’indirizzo di accesso può aprire il client e giocare.
