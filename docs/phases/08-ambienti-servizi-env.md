# Fase 8 — Ambienti, servizi ed env

**Obiettivo:** l'agent controlla l'ambiente di sviluppo in modo riproducibile, senza mai vedere i segreti.
**Dipendenze:** Fase 7. **Pacchetti:** `packages/environment`.

## Step 8.1 — Schema del manifest

File versionato nel repository dell'utente, leggibile a mano. Contiene:

- **Progetto**: nome, descrizione, ambienti disponibili (almeno `dev` e `test`), ambiente di default.
- **Servizi**: identificatore, nome leggibile, tipo (processo locale o Docker/Compose), comando di avvio e stop opzionale, working directory, porte e porta primaria, scope env, dipendenze (grafo aciclico), healthcheck (HTTP, TCP o comando, con bersaglio, intervallo, timeout, tentativi), politica di riavvio, etichette per la UI.
- **Task**: comandi nominati riutilizzabili (build, lint, migrazioni, generazione tipi) con working directory, scope env e descrizione.
- **Seed**: script nominati con ordine, dipendenze dai servizi e flag distruttivo; uno indicato come seed di riferimento per i test.
- **Cleanup**: procedure di pulizia, ciascuna con flag distruttivo esplicito.
- **QA**: URL base per ambiente, URL esterni autorizzati con motivazione, cartella dei test Cypress e naming.

## Step 8.2 — Validazione

Errori leggibili con campo, valore ricevuto e correzione attesa. Oltre alla forma, controlli semantici: cicli nelle dipendenze, porte duplicate, scope env inesistenti, servizi citati nei seed ma non definiti.

## Step 8.3 — Inferenza del manifest

Se il manifest non esiste, l'agent analizza gestori di pacchetti, script, Compose, Dockerfile e framework rilevati e **propone** un manifest completo come diff da approvare. Resta un file dell'utente: versionato, modificabile a mano, e ogni modifica dell'agent passa dall'approvazione.

## Step 8.4 — Supervisor dei servizi

- Avvio in ordine topologico: healthcheck atteso prima di far partire i dipendenti, timeout complessivo che indica chi ha bloccato la catena.
- Rilevamento dei conflitti di porta **prima** dell'avvio, con indicazione del processo occupante e proposta di risoluzione.
- Log per servizio persistiti su disco, ultime 5000 righe in memoria, resto su file con rotazione.
- Politica di riavvio e gestione dei crash, con stato visibile e ultimo output rilevante.
- Arresto pulito con escalation: terminazione richiesta, attesa, terminazione forzata dell'albero. Alla chiusura nessun processo resta attivo; se un arresto fallisce l'evento è registrato e mostrato al riavvio.

## Step 8.5 — Docker e Compose

Per i servizi che lo dichiarano: verifica del runtime con messaggio chiaro se manca, avvio e stop per servizio, log, stato dei container. Le operazioni che rimuovono volumi sono distruttive.

## Step 8.6 — Servizio env

- Il manifest dichiara quale file `.env.*` corrisponde a quale scope: il sistema non inventa convenzioni proprie.
- L'agent può **elencare le chiavi** per scope, verificarne l'esistenza, scrivere o aggiornare un valore. **Non ne legge mai i valori**, che non entrano nel contesto del modello né nelle sintesi.
- **Gate gitignore**: prima di ogni scrittura verificare che il file sia ignorato. Se non lo è, avvisare, proporre l'aggiornamento di `.gitignore` e **non scrivere** finché non è risolto o l'utente non forza.
- La UI mostra solo nomi delle chiavi e scope; rivelare un valore è un'azione manuale dell'utente che non passa dall'agent.
- Costruzione dell'ambiente dei processi a partire dallo scope del servizio.
- Manutenzione di un `.env.example` con le sole chiavi, versionabile.

## Step 8.7 — Filtro di redazione

Alimentato dai valori noti, applicato a output dei comandi, log di servizi e browser, artefatti dei test ed export. Copre le forme codificate: URL-encoded, base64, JSON escaped. Sempre attivo, non disattivabile.

## Step 8.8 — Task, seed e cleanup

Esecuzione dai tool con scope env corretto, ordine dichiarato e conferma per gli elementi distruttivi.

## Step 8.9 — Pannello ambienti e tool

Vista dei servizi con stato, porte, healthcheck e ultimo output; vista del manifest e dei file env con chiavi per scope e stato di gitignore. Tool: lettura e scrittura manifest, avvio, stop e stato ambiente, seed, cleanup, elenco e verifica chiavi, scrittura chiave, verifica gitignore.

## Test richiesti

- Unit: parsing e validazione del manifest con casi di errore; redazione su tutte le forme codificate.
- Integration: ordine di avvio con healthcheck, conflitto di porta, arresto pulito, riavvio dopo crash, rifiuto di scrittura su file env non ignorato.

## Punti da chiudere

- **Q2** — formato e nome del file di manifest. **Q3** — convenzione dei file `.env.*` e sua dichiarazione nel manifest.

## Criteri di uscita

- Sul demo l'agent avvia l'intero ambiente da zero, gli healthcheck passano, i seed girano, i log sono consultabili, l'arresto non lascia orfani.
- Nessun valore di `.env.*` compare in un log o nel contesto del modello.

## Rischi

- Eterogeneità dei progetti reali; differenze di Docker tra piattaforme.
