# Fase 2 — Fondamenta applicative

**Obiettivo:** un'applicazione Electron solida, sicura e vuota di funzionalità.
**Dipendenze:** Fase 1. **Pacchetti:** `apps/desktop`, `apps/renderer`, `packages/shared`, `packages/storage`.

## Step 2.1 — Monorepo e toolchain

- Workspace a pacchetti con la struttura del documento master; ogni pacchetto ha `build`, `test`, `lint` ed è testabile in isolamento.
- TypeScript rigoroso: `strict`, nessun tipo implicito ai confini, project references tra pacchetti.
- Regola di lint che vieta gli import dal renderer verso i pacchetti privilegiati.
- CI su ogni modifica: lint, tipi, unit e integration. Linux come default, matrice tre OS attivabile.

**Fatto quando:** da repo fresco, install, build, lint e test girano puliti.

## Step 2.2 — `packages/shared`

Unica fonte di verità dei contratti:

- tipi di dominio: `SessionState`, `Turn`, `PlanStep`, `ToolCall`, `ToolResult`, `RiskLevel`, `AgentMode`, `ApprovalGrant`, `WorkspaceRef`;
- contratti IPC come coppie richiesta/risposta più eventi push, ciascuno con **schema validabile a runtime**, non solo tipi TypeScript;
- codici di errore applicativi, con messaggio per l'utente separato dal dettaglio tecnico.

## Step 2.3 — Shell Electron sicura

- La finestra principale carica **solo risorse locali**: nessun contenuto remoto nel renderer dell'IDE.
- `contextIsolation` attivo, `nodeIntegration` disattivato, sandbox del renderer attiva, `webSecurity` mai disabilitata.
- CSP restrittiva senza `unsafe-inline` e senza origini remote; le violazioni vengono registrate.
- Blocco di navigazione e apertura finestre verso origini non previste; i link esterni vanno al browser di sistema previa conferma.
- Istanza singola, ripristino di posizione e dimensione, chiusura pulita con hook riservati ai servizi delle fasi successive.

## Step 2.4 — Bridge IPC

- Preload che espone una superficie minima e nominata, senza oggetti Node grezzi.
- Ogni messaggio verso il main è validato: i non conformi vengono rifiutati, contati e registrati con canale e motivo.
- Nessun canale generico "esegui qualsiasi cosa": un canale per capacità.
- Correlazione richiesta/risposta, timeout e propagazione dell'annullamento.

## Step 2.5 — Stato di sessione

- Modello unico nel main che descrive conversazione, piano, tool in corso, approvazioni, servizi e test.
- Il renderer riceve lo stato iniziale e poi aggiornamenti incrementali: non muta mai lo stato in locale, invia solo intenzioni.
- Sequenza monotona sugli aggiornamenti per rilevare perdite e forzare una risincronizzazione completa.

## Step 2.6 — `packages/storage`

- Persistenza locale per progetto con **schema versionato** e migrazioni all'avvio, con backup del file precedente.
- Contenuti: conversazioni e piani, audit delle azioni, indice di log e artefatti su disco, indice dei checkpoint, preferenze globali e di workspace. Nessun segreto.
- Scritture atomiche (file temporaneo più rename): un crash non corrompe conversazioni né configurazioni.
- Tre livelli di configurazione con precedenza progetto, workspace locale, globale.
- Azione unica per cancellare tutti i dati locali di un progetto.

## Step 2.7 — Keychain

Servizio credenziali basato sullo spike 1.4: scrittura, lettura, cancellazione, gestione del keychain indisponibile con messaggio chiaro. Nessuna credenziale in alcun file di configurazione.

## Step 2.8 — Apertura del workspace

Selezione della cartella, validazione (esistenza, permessi, presenza di `.git`), elenco dei progetti recenti, calcolo e memorizzazione del **percorso reale risolto**, che sarà il perimetro della Fase 4.

## Step 2.9 — Scheletro del cockpit

Due superfici affiancate ancora vuote, tema scuro di default e chiaro disponibile, token del sistema di design (colori, tipografia, spaziature, densità), stati vuoti e componenti base.

## Test richiesti

- Unit: validazione dei messaggi IPC, migrazione in avanti da ogni versione di schema, precedenza dei tre livelli di configurazione.
- Integration: crash durante una scrittura senza corruzione; rifiuto di un messaggio malformato; blocco della navigazione verso un'origine esterna.

## Punti da chiudere

- **Q5** — formato di persistenza e strategia di migrazione. **Q7** — prima versione del sistema di design.

## Criteri di uscita

- L'app si avvia sui tre OS, apre un workspace e ricorda configurazione e finestra dopo il riavvio.
- Isolamento, bridge validato, CSP e assenza di contenuto remoto sono soddisfatti e coperti da test.
- CI verde su lint, tipi e suite.

## Rischi

- Sovraingegnerizzare prima di avere feedback dal prodotto.
- Contratti IPC troppo permissivi, che diventano scorciatoie nelle fasi successive.
