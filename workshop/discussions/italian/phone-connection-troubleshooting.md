# Non riesci a connetterti da un telefono o un tablet?

> Questa è una traduzione della discussione del Workshop di Steam [Can't connect from a phone? Read this first](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/). Per fare una domanda o segnalare un problema, lascia un commento in quella discussione: non serve scrivere in inglese, puoi scrivere in italiano.

La maggior parte dei problemi di connessione si riduce a una manciata di cause. Questo elenco va più o meno dalla più comune alla meno comune, quindi conviene seguirlo in ordine.

*Se il telefono raggiunge senza problemi la pagina per unirsi alla partita e il problema è un altro - un crash, un giocatore che non finisce mai di unirsi, qualcosa che non va nel gioco stesso - consulta invece [Hai un problema? Scrivilo nella discussione di Steam](reporting-a-problem.md).*

---

## Cose da provare

### 1. Scegli un altro indirizzo nella schermata del codice QR

La schermata del codice QR ha un selettore con diversi modi per raggiungere l'host. Se quello che hai scansionato non funziona, scegline un altro e scansiona di nuovo.

Preferisci il semplice indirizzo numerico (qualcosa come **192.168.1.5:13337**). È quello con meno elementi che possono andare storti. Il nome **.local** e il collegamento web dipendono entrambi da cose esterne alla mod - il tuo router, una connessione a Internet, i permessi del browser - quindi possono non funzionare su una rete in cui l'indirizzo numerico funziona benissimo.

**Su iPhone o iPad, salta del tutto la riga *Collegamento Web*.** Safari - e ogni altro browser su iOS, perché sotto sono tutti Safari - non permette a una pagina caricata da Internet di raggiungere nulla sulla tua rete di casa. È una regola del browser, non un'impostazione, quindi non c'è niente da consentire e niente da cambiare: la pagina si caricherà e poi ti dirà che il gioco non ha risposto, su qualsiasi rete e comunque sia configurato il firewall. Su iPhone o iPad usa **Indirizzo semplice** o **Collegamento sicuro**. (Ora è la pagina stessa a dirlo, se arrivi fin lì.)

### 2. Assicurati che il telefono sia davvero sulla stessa rete

- La stessa rete Wi-Fi del computer host, e non la **rete ospiti**. Le reti ospiti di solito impediscono ai dispositivi di comunicare tra loro, che è proprio ciò che serve qui.
- Non con i dati mobili. Se il Wi-Fi non ha accesso a Internet, a volte i telefoni passano da soli ai dati mobili senza avvisarti.
- **Disattiva qualsiasi VPN sul telefono.** È un errore in cui cadono in tanti. Contano anche gli ad blocker e le app di «DNS privato» che funzionano come una VPN.

### 3. Leggi cosa dice la pagina mentre ti unisci

Avviare la partita di un giocatore può richiedere fino a un minuto, ed è normale, non un guasto. Nel frattempo la pagina ora ti dice a che punto è arrivata, in una riga sotto *Unione alla partita…*:

*Connessione all'host — passaggio 1 di 6, 14 s finora. Può richiedere fino a un minuto, quindi tieni aperta questa pagina.*

Se quella riga continua a contare e cambia fase, sta funzionando: tieni aperta la pagina. Le sei fasi sono «Connessione all'host», «In attesa dell'host», «Avvio del gioco di questo giocatore», «Collegamento di questo giocatore alla partita», «Caricamento della vista di gioco» e «Quasi pronto».

### 4. Se si blocca, ora la pagina ti dice PERCHÉ

Quando qualcosa va davvero storto, il tuo dispositivo viene informato di quale tra diversi problemi non collegati tra loro si tratta - in due frasi, più una riga tecnica grigia. **Includi tutto in qualsiasi segnalazione.** Puoi riceverne tre, e richiedono soluzioni completamente diverse:

- «**Il tuo gioco è in esecuzione sul computer host, ma questo dispositivo non è riuscito a raggiungerlo.**»\
  È il percorso di rete tra il telefono e l'host - Wi-Fi ospite, una VPN o un router che tiene separati i dispositivi. Il gioco dell'host non ha nessun problema. Vedi le sezioni 2 e 6.
- «**Un altro programma sul computer host sta usando la porta di cui ha bisogno il tuo gioco.**»\
  Non c'è niente da cambiare sul tuo dispositivo. Sull'host, qualcos'altro sta occupando una delle porte di cui ha bisogno ogni giocatore - il più delle volte un processo di un giocatore rimasto da una sessione precedente. Chi ospita dovrebbe chiuderlo (riavviare Slay the Spire 2 lo elimina).
- «**Il computer host sta bloccando la porta su cui viene servito il tuo gioco.**»\
  Anche qui non c'è niente da cambiare sul tuo dispositivo. A bloccarla è il firewall o il software di sicurezza dell'host stesso - vedi la sezione 5.

**Il caso di blocco più comune non mostra affatto *Unione alla partita…*.** Se il tuo dispositivo ha raggiunto l'host ma non riesce a raggiungere la porta assegnata al tuo giocatore, l'ingresso nella partita *riesce* - e poi la pagina passa a *Caricamento…* e resta lì. In quella schermata non c'è né una riga di avanzamento né un conto alla rovescia, perché dal punto di vista dell'host non è fallito nulla. La prima cosa utile che vedrai è il messaggio «**non è riuscito a raggiungerlo**» qui sopra, circa **20 secondi** dopo il cambio di pagina. Quindi, se sei bloccato su *Caricamento…*, aspetta mezzo minuto quel messaggio invece di ricaricare: ricaricare fa ripartire tutta l'attesa.

Se invece resta su *Unione alla partita…* e non cambia mai, l'host si arrende dopo 75 secondi con «*Impossibile avviare la visualizzazione del gioco: riprova.*» e una riga grigia sotto. È un errore diverso da quello descritto sopra. In entrambi i casi, copia quello che dice.

### 5. Ogni giocatore usa la propria porta

La lobby è sulla porta **13337**, poi ogni giocatore usa la **13357**, la **13367**, la **13377** e così via. Una regola del firewall che apre solo la 13337 ti permette di raggiungere l'elenco dei giocatori e poi fallisce al secondo passaggio. Se ne hai aggiunta una (da solo o seguendo una guida), rimuovila e consenti invece **il programma del gioco**: così sono coperte tutte le porte di cui ha bisogno.

### 6. Windows: consenti il gioco attraverso il firewall

Per prima cosa controlla il tipo di rete, perché già questo blocca molte connessioni:

- **Impostazioni > Rete e Internet > Wi-Fi** (o Ethernet) > fai clic sulla tua rete > imposta **Tipo di profilo di rete** su **Rete privata**.

Poi consenti il gioco:

- **Impostazioni > Privacy e sicurezza > Sicurezza di Windows > Firewall e protezione rete > Consenti app tramite firewall**
- Trova **Slay the Spire 2** nell'elenco e assicurati che **Privato** sia selezionato. Se non è nell'elenco, usa **Consenti un'altra app...** e cerca il file `.exe` del gioco.

Se a un certo punto hai risposto «Annulla» a una richiesta del firewall di Windows, Windows lo ricorda come una regola di blocco e non te lo chiederà mai più. In quel caso devi rimuovere la voce sopra e aggiungerla di nuovo.

**Aprire l'indirizzo in un browser sul PC host stesso non dimostra nulla.** È la prima cosa che viene in mente di provare, ed è stato verificato che è fuorviante: Windows non filtra il traffico di un computer verso se stesso - nemmeno verso il proprio indirizzo di rete - quindi, anche con il firewall che blocca attivamente ogni telefono, il browser dell'host carica comunque la pagina alla perfezione. Se per te ha funzionato, ti dice che il gioco è in esecuzione e sta servendo la pagina. Non dice assolutamente nulla sul firewall.

Seleziona **Pubblico** solo se la tua rete è impostata come pubblica e non puoi cambiarla. Selezionandolo, il gioco diventa raggiungibile su qualsiasi rete a cui ti colleghi, compresi bar e hotel.

### 7. Il router

Alcuni router impediscono ai dispositivi sulla stessa rete Wi-Fi di raggiungersi a vicenda. Cerca un'impostazione chiamata **AP isolation**, **Client isolation** o **Wireless isolation** (in italiano spesso «isolamento AP») e disattivala.

Buono a sapersi, inoltre: un ripetitore Wi-Fi o un adattatore powerline configurato in modalità **router** invece che **bridge** / **access point** mette il telefono su una rete separata da quella dell'host, anche se il nome del Wi-Fi sembra lo stesso.

### 8. Impostazioni del browser che bloccano gli indirizzi semplici

Alcuni browser cercano di forzare HTTPS su ogni indirizzo, e il semplice indirizzo numerico non lo usa. (La riga **Collegamento sicuro** nella schermata del codice QR è quella che lo usa: quindi, se il problema è l'HTTPS forzato, vale la pena provare anche quella riga.) Se la barra degli indirizzi mostra un avviso di sicurezza invece del gioco, disattiva queste opzioni e riprova:

- Chrome: **Impostazioni > Privacy e sicurezza > Sicurezza > Utilizza sempre connessioni sicure**
- Firefox: **Impostazioni > Privacy e sicurezza > Modalità solo HTTPS**

Su iPhone, controlla anche in **Impostazioni > App > Safari** Relay privato iCloud e «Nascondi indirizzo IP».

### 9. Antivirus con un proprio firewall

Le suite di sicurezza come ESET, Bitdefender, Norton, Kaspersky e Avast hanno un proprio firewall, separato da quello di Windows. Consentire il gioco in Windows non serve a nulla per quelle. Controlla le impostazioni di rete o del firewall della suite stessa, oppure metti brevemente in pausa il suo firewall per vedere se è quello a bloccare.

### 10. Se prima funzionava e poi ha smesso

L'indirizzo del computer host può cambiare quando si ricollega al Wi-Fi o dopo un riavvio del router. Apri di nuovo la schermata del codice QR e scansiona ancora: il nuovo indirizzo sarà lì.

Se hai aggiunto il client alla schermata Home, cosa succede dipende dalla riga da cui l'hai installato:

- Installato dalla riga **Collegamento Web**: continua a funzionare e trova da solo il nuovo indirizzo. Basta aprirlo, senza scansionare di nuovo.
- Installato dall'**indirizzo numerico** o dalla riga **Collegamento sicuro**: l'icona punta al vecchio indirizzo e non può ripristinarsi. Eliminala e aggiungila di nuovo dopo aver scansionato ancora. (Su Android, installarlo invece dalla riga **Collegamento Web** evita il problema una volta per tutte. Su iPhone o iPad quella riga non può funzionare - vedi la sezione 1 - quindi lì l'unico modo è aggiungere di nuovo l'icona.)

---

## Ancora bloccato? Commenta nella discussione di Steam

Lascia un commento nella [discussione di Steam](https://steamcommunity.com/workshop/filedetails/discussion/3799476240/563668239243032720/) - non serve rispondere a tutto. Anche solo una o due di queste informazioni rendono una segnalazione molto più facile da gestire, e la prima domanda vale più di tutte le altre messe insieme.

### Fin dove arriva?

È la cosa più utile che puoi dirmi, perché ogni risposta indica una causa diversa:

- il browser non carica mai niente
- la pagina si carica, ma l'elenco dei giocatori non compare mai
- puoi scegliere un nome, ma resta su «Unione alla partita…» - dimmi cosa diceva la riga di avanzamento sotto, e quale messaggio hai ricevuto se hai aspettato
- supera quel punto e resta invece su «**Caricamento…**» - questo è il caso porta/firewall, ed è il più comune. Dimmi se il messaggio «non è riuscito a raggiungerlo» è comparso dopo circa 20 secondi
- si è connesso senza problemi, poi è caduto durante la partita

### Qualsiasi altra cosa puoi aggiungere

- Il messaggio esatto che mostra il telefono, compresa la riga grigia sotto. Una foto dello schermo è perfetta.
- Quale indirizzo hai scansionato: quello numerico, il nome **.local** o il collegamento web.
- Sistema operativo dell'host, e modello e browser del telefono o tablet.
- Non funziona su **tutti** i dispositivi o solo su uno? Se un telefono funziona e un altro no, si escludono molte cause.
- Ha mai funzionato prima, ed è cambiato qualcosa da allora?
- Host in Wi-Fi o via Ethernet. Eventuali VPN attive sull'host o sul telefono. Eventuali antivirus con firewall.

### Tre cose che il computer host può darti

- **Il pannello delle connessioni.** Sull'host, apri la schermata **Codice QR di Couch Co-Op**: il pannello **Connessioni** si trova lì, sotto il codice. Vi sono elencati i dispositivi arrivati abbastanza avanti da comparire, e tutto ciò che è andato storto viene conservato sotto **Problemi di connessione** (seguito da un numero). Seleziona la riga e usa **Copia rapporto**: copia un rapporto che contiene già il passaggio fallito, i tempi e la diagnosi dell'host stesso. Incollalo direttamente nel tuo commento. Indica anche il percorso esatto di entrambi i file di log qui sotto, così non devi cercarli.
- **Il file di log principale.** Su Windows, `%APPDATA%\SlayTheSpire2\logs\godot.log`. Su Linux, `~/.local/share/SlayTheSpire2/logs/godot.log`. Su macOS, `~/Library/Application Support/SlayTheSpire2/logs/godot.log`.
- **Il log di ogni giocatore.** Ogni giocatore che si unisce ottiene una propria copia del gioco in esecuzione in background sull'host, e ognuna tiene il proprio log. **Se l'ingresso è arrivato a *Unione alla partita…* e poi è scaduto il tempo, è questo il file che spiega perché** - il log principale qui sopra di solito no. I giocatori sono numerati a partire da 2, quindi la prima persona che si unisce è `slot-2`: su Linux è `~/.local/share/SlayTheSpire2/couch-coop/headless-slots/slot-2/SlayTheSpire2/logs/godot.log` (sì, `SlayTheSpire2` due volte: non è un errore di battitura), e i percorsi di Windows e macOS hanno la stessa struttura sotto le rispettive cartelle indicate sopra. In alcune configurazioni, invece, è un unico file in `couch-coop/seat-logs/slot-2.log`.

**Quali righe contano.** In entrambi i log, quelle utili contengono `[couchcoop]` - hanno un aspetto come `[INFO] [couchcoop] ...` - più tutte le righe `[ERROR]`, anche quelle che non menzionano couchcoop. Di solito bastano da sole.

**Prima di incollare un log intero:** la discussione di Steam è pubblica, e un log contiene il tuo **SteamID64** (un numero lungo che inizia con 7656 e rimanda al tuo profilo Steam) e il **nome utente** del tuo computer, nei percorsi dei file. *Non* contiene password, e non contiene gli account degli altri giocatori, solo il tuo. Se preferisci non pubblicarli, basta un trova e sostituisci su questi due dati prima di incollare, oppure pubblica solo le righe `[couchcoop]` e `[ERROR]`: se mi serve altro, te lo chiederò.

---

Un'ultima nota: chiunque riesca a raggiungere l'indirizzo per unirsi può aprire il client e giocare, quindi usalo su una rete di cui ti fidi.
