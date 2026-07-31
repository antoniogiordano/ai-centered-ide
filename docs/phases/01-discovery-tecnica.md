# Fase 1 — Discovery tecnica

**Obiettivo:** eliminare l'incertezza sulle scelte a rischio prima di costruire.
**Dipendenze:** nessuna. **Output:** spike usa-e-getta, versioni fissate, `fixtures/demo-project`.

Il codice di questa fase è throwaway: dimostra fattibilità e non entra nei pacchetti definitivi. Ogni spike si chiude con una nota breve e datata in `docs/notes`.

## Step 1.1 — Spike PTY

Eseguibile Node minimo che apre una pseudo-terminale reale e:

- avvia una shell interattiva con working directory e ambiente espliciti;
- esegue un comando con output continuo per 60 secondi senza perdita di byte né encoding corrotto;
- distingue stdout ed stderr, con timestamp per chunk;
- gestisce il resize della finestra;
- termina l'**intero albero di processi** (comando che genera figli) senza lasciare orfani, verificato ispezionando la lista processi;
- regge 50k righe al secondo senza bloccare l'event loop.

Verificare su macOS (zsh), Windows (PowerShell e cmd) e Linux (bash). Documentare differenze su segnali, kill dell'albero, quoting e percorsi.

### Implementazione

1. **Struttura del progetto**:
   - Creare una cartella `spikes/pty` con un file `index.ts` e `package.json`.
   - Usare `node-pty` come libreria di riferimento per la gestione delle terminali.

2. **Funzionalità chiave**:
   - Implementare un ciclo di lettura che catturi stdout e stderr separatamente.
   - Aggiungere gestione dei segnali per terminare l'albero di processi.
   - Testare la resilienza con output ad alta frequenza.

3. **Documentazione**:
   - Creare un file `docs/notes/pty-spike-2026-07-30.md` con i risultati dei test su ogni OS.

## Step 1.2 — Spike superficie browser isolata

Prototipare la superficie che ospiterà l'app dell'utente, confrontando le opzioni disponibili in Electron. Deve:

- caricare un'app locale in un contesto separato dal renderer dell'IDE, con sessione e cookie dedicati;
- impedire qualunque accesso alle API interne dell'IDE;
- esporre i messaggi di console con livello e stack;
- esporre le richieste di rete con metodo, URL, stato, durata e dimensione;
- catturare screenshot di viewport e pagina intera;
- cambiare viewport (desktop, tablet, mobile) e azzerare i dati di sessione.

**Fatto quando:** una SPA locale è navigabile e tutti i canali di osservazione funzionano.

### Implementazione

1. **Struttura del progetto**:
   - Creare una cartella `spikes/browser-surface` con un file `index.ts` e `package.json`.
   - Usare `electron` come dipendenza principale.

2. **Funzionalità chiave**:
   - Implementare un browser isolato con `BrowserView` o `webContents`.
   - Aggiungere listener per console logs e richieste di rete.
   - Testare la cattura di screenshot con diverse risoluzioni.

3. **Documentazione**:
   - Creare un file `docs/notes/browser-surface-spike-2026-07-30.md` con i risultati dei test.

## Step 1.3 — Spike recorder

Sulla superficie dello step 1.2, catturare l'interazione umana su una SPA con routing client-side:

- navigazioni, click, digitazione con debounce, select, checkbox, submit, cambio viewport;
- per ogni evento raccogliere i **candidati selettore**: attributi dedicati ai test, ruolo e nome accessibile, testo visibile, id e attributi stabili, percorso strutturale;
- registrare ordine temporale e attese implicite tra un evento e il successivo.

Verificare la tenuta su re-render, portali, shadow DOM e iframe, documentando cosa non è catturabile.

**Fatto quando:** dieci interazioni producono una traccia strutturata completa e rigiocabile a mano.

### Implementazione

1. **Struttura del progetto**:
   - Estendere la cartella `spikes/browser-surface` con un file `recorder.ts`.
   - Usare `puppeteer` o `playwright` per la cattura degli eventi.

2. **Funzionalità chiave**:
   - Implementare un sistema di debounce per gli eventi di input.
   - Raccogliere selettori multipli per ogni elemento interagito.
   - Salvare la traccia in formato JSON strutturato.

3. **Documentazione**:
   - Creare un file `docs/notes/recorder-spike-2026-07-30.md` con i risultati dei test.

## Step 1.4 — Spike keychain

Scrittura, lettura, aggiornamento e cancellazione di una credenziale nel keychain sui tre OS, incluso il comportamento con keychain bloccato o indisponibile. Documentare il fallback: nessuna scrittura in chiaro su disco, mai.

### Implementazione

1. **Struttura del progetto**:
   - Creare una cartella `spikes/keychain` con un file `index.ts` e `package.json`.
   - Usare `keytar` come libreria di riferimento.

2. **Funzionalità chiave**:
   - Implementare operazioni CRUD sul keychain.
   - Gestire errori per keychain bloccato o indisponibile.
   - Testare il fallback su tutti gli OS.

3. **Documentazione**:
   - Creare un file `docs/notes/keychain-spike-2026-07-30.md` con i risultati dei test.

## Step 1.5 — Fissare le versioni

Scegliere e motivare le versioni di Electron, Node, TypeScript, React, Vite, Monaco, Cypress, gestore di pacchetti e libreria PTY. Registrarle in `docs/notes/versions.md` con data e criterio di aggiornamento.

### Implementazione

1. **Criteri di selezione**:
   - Preferire versioni LTS per Electron e Node.
   - Scegliere le ultime versioni stabili per React, Vite e Cypress.
   - Verificare la compatibilità tra le librerie.

2. **Documentazione**:
   - Creare un file `docs/notes/versions.md` con una tabella delle versioni e motivazioni.

## Step 1.6 — Repository demo

Creare `fixtures/demo-project`: frontend SPA, API HTTP, database in Docker Compose, file `.env` per ambiente, script di seed e un flusso utente verificabile (autenticazione, lista, creazione di un elemento). Includere **un bug intenzionale** descritto in un file a parte, non nel codice, da usare in Fase 9 e 10.

**Fatto quando:** un umano avvia il demo a mano con Compose e completa il flusso nel browser.

### Implementazione

1. **Struttura del progetto**:
   - Creare una cartella `fixtures/demo-project` con:
     - `frontend/` (SPA con React/Vue)
     - `backend/` (API HTTP con Express/Fastify)
     - `docker-compose.yml`
     - `.env.example`
     - `seed.sh`

2. **Funzionalità chiave**:
   - Implementare un flusso utente completo (autenticazione, lista, creazione).
   - Aggiungere un bug intenzionale (es. validazione mancante).
   - Documentare il bug in `docs/bug-intenzionale.md`.

3. **Test**:
   - Verificare l'avvio manuale con Docker Compose.

## Punti da chiudere

- **Q1** — tecnologia della superficie browser QA e meccanismo di cattura eventi del recorder, con le alternative scartate e il motivo.

## Criteri di uscita

- I quattro spike hanno esito documentato sui tre sistemi operativi, o la limitazione è scritta con la strategia alternativa.
- Q1 chiusa, versioni fissate, demo avviabile end-to-end senza l'IDE.

## Rischi

- Sottovalutare le differenze tra OS su segnali e terminazione degli alberi di processi.
- Trasformare gli spike in prodotto: vanno cancellati e riscritti in Fase 2.

## Timeline

- **Giorno 1**: Spike PTY e superficie browser isolata.
- **Giorno 2**: Spike recorder e keychain.
- **Giorno 3**: Fissare versioni e repository demo.
- **Giorno 4**: Test su tutti gli OS e documentazione.

## Responsabili

- **PTY**: [Nome Responsabile]
- **Browser Surface**: [Nome Responsabile]
- **Recorder**: [Nome Responsabile]
- **Keychain**: [Nome Responsabile]
- **Versioni e Demo**: [Nome Responsabile]

---

**Stato attuale**: Inizio sviluppo (2026-07-30)

**Prossimi passi**:
1. Creare la struttura dei spike.
2. Implementare PTY e browser surface.
3. Testare su tutti gli OS.
4. Documentare i risultati.
