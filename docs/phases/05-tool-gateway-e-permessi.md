# Fase 5 — Tool gateway e permessi

**Obiettivo:** un unico punto di esecuzione per ogni azione dell'agent, con policy applicata senza scorciatoie.
**Dipendenze:** Fase 4. **Pacchetti:** `packages/tools`.

## Step 5.1 — Contratto dei tool

Ogni tool dichiara: nome stabile, descrizione scritta per il modello, schema degli argomenti validato a runtime, classificazione di rischio, timeout, e output strutturato con esito, sintesi breve e riferimento all'artefatto completo. Nessun tool scrive direttamente sul disco o lancia processi: usa i servizi della Fase 4.

Il registro è l'unica sorgente dei tool esposti al modello: aggiungere un tool senza registrarlo deve essere impossibile.

## Step 5.2 — Classificazione del rischio

Tabella centralizzata, non dispersa nel codice:

| Classe | Esempi |
| --- | --- |
| Sicure | lettura file, elenco, ricerca, stato Git, diff, lettura log, screenshot, comandi in allowlist |
| Reversibili | scrittura e modifica di file nel workspace, stage, avvio e stop di servizi, esecuzione test |
| Sensibili | installazione dipendenze, scrittura di `.env.*`, commit, cambio branch, comandi arbitrari, accesso a URL esterni |
| Distruttive | cancellazione ricorsiva, reset e clean, riscrittura della storia, push, rimozione di volumi Docker, privilegi elevati, qualunque percorso fuori dal workspace |

## Step 5.3 — Policy per modalità

| Modalità | Lettura | Scrittura file | Comandi | Servizi | Browser QA | Rete esterna |
| --- | --- | --- | --- | --- | --- | --- |
| Ask | Sì | No | No | No | Sola lettura | No |
| Plan | Sì | No | Solo allowlist | No | Sola lettura | No |
| Agent | Sì | Sì | Sì, conferma fuori allowlist | Sì | Sì | Con conferma |
| Autonomous | Sì | Sì | Sì, conferma se distruttivo | Sì | Sì | Con conferma |

Regole trasversali: scrittura solo nel workspace; le azioni distruttive richiedono conferma **anche in Autonomous**; il passaggio ad Autonomous è deliberato, per sessione, e non sopravvive al riavvio.

## Step 5.4 — Approvazioni

- Richiesta di approvazione con descrizione in linguaggio chiaro dell'azione, dell'effetto e, se distruttiva, di **cosa si perde e come recuperarlo**.
- Esiti possibili: approva una volta, rifiuta, approva per la sessione limitatamente a una **categoria** di azione. Mai un'approvazione totale indiscriminata.
- Le concessioni sono elencate in un pannello di sessione, revocabili singolarmente, e non sopravvivono alla chiusura dell'app.
- Un rifiuto torna al modello come osservazione, non come errore fatale.

## Step 5.5 — Gestore PTY

Basato sullo spike 1.1: esecuzione one-shot con timeout (default 120 secondi) e terminazione dell'albero di processi allo scadere; working directory sempre esplicita e dentro il workspace; ambiente derivato dallo scope env; output catturato integralmente nell'archivio artefatti e restituito troncato con sintesi ed exit code.

## Step 5.6 — Catalogo iniziale dei tool

Filesystem e ricerca: lettura file, elenco directory, ricerca testuale, ricerca file, scrittura, modifica mirata, eliminazione.
Git: stato, diff, stage, unstage, commit, branch, operazioni distruttive.
Terminale: esecuzione comando.
Checkpoint: elenco e ripristino.

## Step 5.7 — Allowlist e denylist

- Allowlist di comandi di sola lettura, modificabile, eseguibili senza conferma.
- **Denylist non svuotabile** dall'utente: comandi sempre bloccati o sempre confermati, con matching robusto a varianti, alias, concatenazioni con `&&`, pipe, sostituzioni di comando e privilegi elevati.
- Il parsing del comando deve fallire in modo conservativo: se non è interpretabile, si chiede conferma.

## Step 5.8 — Audit e redazione

Ogni invocazione registra tool, argomenti, decisione di policy, approvazione, esito, durata e riferimento all'artefatto. Ogni output attraversa il filtro di redazione (esteso in Fase 8) prima di raggiungere modello, UI e log.

## Test richiesti

- Unit: matrice policy per ogni classe di rischio e ogni modalità; parsing dei comandi contro la denylist, incluse le varianti di evasione; validazione degli argomenti.
- Integration: sequenza scrittura e ripristino sul repository di fixture; comando in timeout che non lascia processi; rifiuto di approvazione gestito correttamente.

## Punti da chiudere

- **Q6** — composizione precisa di allowlist e denylist.

## Criteri di uscita

- Nessun percorso di esecuzione aggira il gateway, verificato per ispezione del codice e per test.
- Le azioni distruttive chiedono conferma anche in Autonomous; la denylist blocca i comandi previsti e non è svuotabile.
- Ogni azione compare nell'audit con esito.

## Rischi

- Classificazione incompleta che lascia scoperta un'azione pericolosa.
- Troppe conferme in modalità Agent: misurare l'attrito su un task reale.
