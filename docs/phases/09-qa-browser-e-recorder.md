# Fase 9 — Browser QA e recorder Cypress

**Obiettivo:** verifica visuale e generazione dei test dal comportamento reale.
**Dipendenze:** Fase 8. **Pacchetti:** `packages/qa`.

## Step 9.1 — Superficie browser QA

Basata sulla decisione Q1. Isolata dal renderer, con sessione separata e persistenza limitata al progetto, nessun accesso alle API interne. Il contenuto caricato è **non fidato** e non può in alcun modo elevare i permessi dell'agent.

Controlli: barra indirizzi limitata ai target autorizzati, ricarica, viewport desktop, tablet e mobile, cancellazione dei dati di sessione, pulsante di registrazione.

## Step 9.2 — Politica dei target

Consentiti gli URL del manifest per l'ambiente attivo e localhost sulle porte dei servizi. Ogni altro URL richiede autorizzazione esplicita e, se ricorrente, viene proposto per il manifest.

## Step 9.3 — Canali di osservazione

Console con livello e stack, richieste di rete con metodo, URL, stato, durata e **corpi redatti**, screenshot di viewport e pagina intera. Tutto passa dal filtro di redazione della Fase 8 prima di raggiungere UI, log e modello.

## Step 9.4 — Tool browser per l'agent

Navigazione tra i target autorizzati, snapshot accessibile della pagina, screenshot, interazione (click, digitazione, selezione, scroll), console, rete, valutazione di espressioni (sensibile). Il flusso primario di QA resta l'interazione umana.

## Step 9.5 — Recorder: cattura

Sulla base dello spike 1.3, catturare navigazioni, click, digitazioni, selezioni, submit, cambi di viewport e asserzioni implicite (comparsa di testo, cambio URL, comparsa di elementi chiave). Per ogni evento salvare i candidati selettore e le attese verso l'evento successivo.

## Step 9.6 — Asserzioni esplicite

L'utente seleziona un elemento e dichiara cosa deve essere vero: testo presente, elemento visibile, valore di un campo, conteggio, URL corrente. L'asserzione entra nella traccia nel punto temporale corretto.

## Step 9.7 — Rappresentazione semantica

La traccia grezza diventa un modello dello scenario indipendente dal formato del test: passi con intento, bersaglio, dati e asserzioni. Qui si rimuove il rumore (click a vuoto, doppi eventi) e si consolidano le digitazioni. L'elaborazione avviene fuori dal thread principale.

## Step 9.8 — Generazione del test Cypress

Dal modello semantico si genera un file di test **leggibile da un umano**, salvato nella cartella dichiarata nel manifest come modifica da approvare.

Selettori in ordine di preferenza: attributi dedicati ai test, ruoli e testi accessibili, attributi stabili, e solo come ultima risorsa selettori strutturali. Quando il recorder è costretto a un selettore fragile lo segnala e l'agent propone di aggiungere un attributo dedicato al codice.

Il test dichiara le precondizioni (seed richiesto, stato dell'ambiente) e non dipende da dati residui.

## Step 9.9 — Dati sensibili

I valori digitati che corrispondono a segreti noti o che hanno forma di credenziale vengono sostituiti con riferimenti a variabili o fixture. Nessun valore sensibile finisce nel file di test, negli screenshot allegati o nei video.

## Step 9.10 — Rifinitura e stabilità

L'agent rifinisce il test: selettori più stabili, attese al posto di ritardi fissi, nomi parlanti, struttura coerente con gli altri test, dati di seed necessari. Poi lo esegue **due volte** e solo se passa entrambe è accettato. La rigenerazione automatica è disattivata di default: la rifinitura è proposta, mai imposta.

Il test è un file normale del repository: l'utente può modificarlo a mano e il sistema non lo rigenera senza richiesta esplicita.

## Step 9.11 — Esecuzione e diagnostica

Esecuzione headless di un test, di una selezione o dell'intera suite, con ambiente avviato e seed eseguito se dichiarato. In caso di fallimento l'agent riceve un **pacchetto diagnostico strutturato**: passo fallito, messaggio, screenshot, video, console e richieste di rete nella finestra temporale del fallimento.

## Step 9.12 — Pannello test

Elenco dei test, esito e durata dell'ultima esecuzione, cronologia, test generati di recente in attesa di revisione, log e artefatti dei fallimenti.

## Test richiesti

- Unit: traduzione della traccia in modello semantico; scelta del selettore con e senza attributi dedicati; sostituzione dei valori sensibili.
- Integration: dalla **sessione di registrazione di riferimento** salvata come dato si genera il test atteso e lo si esegue, senza interazione umana.

## Punti da chiudere

- **Q8** — struttura del pacchetto diagnostico. **Q9** — rilevamento dei valori sensibili durante la registrazione.

## Criteri di uscita

- Un utente registra uno scenario reale sul demo e ottiene un test leggibile che passa due volte di seguito.
- L'agent diagnostica il bug intenzionale del demo e propone la correzione.
- Nessun valore sensibile compare in test o artefatti.

## Rischi

- Selettori fragili e test instabili; complessità della cattura su SPA moderne.
