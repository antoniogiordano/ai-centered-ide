# Fase 7 — Cockpit e pannelli

**Obiettivo:** la superficie con cui l'utente dirige l'agent e ispeziona il suo lavoro.
**Dipendenze:** Fase 6. **Pacchetti:** `apps/renderer`.

La UI non replica sidebar, editor e panel di VS Code. Due superfici affiancate, tutto il resto on-demand.

## Step 7.1 — Superficie sinistra: conversazione

- Thread con messaggi utente e agent, streaming visibile, stato di lavoro sempre mostrato e interrompibile con un solo comando.
- **Schede azione** compatte al posto dei log grezzi: "modificati 4 file", "eseguito comando", "avviato servizio api", "eseguito test". Ogni scheda mostra esito e durata, si espande per la sintesi e apre il pannello corrispondente per il dettaglio completo.
- Output lunghi sempre troncati con sintesi e accesso al contenuto integrale: la conversazione non deve diventare un dump.

## Step 7.2 — Piano attivo

Lista dei passi con stato per passo, passo corrente evidenziato, collegamento dalle azioni eseguite al passo che le ha generate. In modalità Plan il piano è il risultato del turno ed è approvabile per avviare l'esecuzione.

## Step 7.3 — Approvazioni in linea

- La richiesta compare nel flusso della conversazione, non in un modale, e descrive l'azione in linguaggio comprensibile.
- Pulsanti: approva, rifiuta, approva per la sessione per quella categoria. Per le azioni distruttive, testo esplicito su cosa si perde e come recuperarlo, e conferma rafforzata.
- Pannello delle concessioni attive, con revoca singola.
- Modale bloccante ammesso **solo** per le conferme di sicurezza di livello alto.

## Step 7.4 — Selettore di modalità

Sempre visibile, con etichetta di cosa l'agent può fare senza chiedere nella modalità corrente. Il passaggio ad Autonomous richiede un'azione deliberata e mostra un indicatore persistente.

## Step 7.5 — Superficie destra: verifica

Contenitore con tre stati selezionabili, popolati nelle fasi successive: browser QA, esecuzione test, stato ambiente. In questa fase esiste il contenitore con stati vuoti descrittivi.

## Step 7.6 — Pannello diff e checkpoint

- File modificati nella sessione, con distinzione tra modifiche dell'agent e manuali.
- Diff per file e vista aggregata; accettazione o rifiuto per singolo file.
- Elenco dei checkpoint con data, motivo, file coinvolti e ripristino, che registra un evento nella conversazione.
- Da qui: stage, unstage, commit con messaggio proposto dall'agent ma **sempre confermato dall'umano**, creazione e cambio branch.

## Step 7.7 — Pannello history terminale

Elenco cronologico dei comandi con comando, working directory, exit code, durata e output completo consultabile. Uno stream separato per ogni processo di lunga durata, con ricerca nel testo, autoscroll disattivabile e rendering virtualizzato per reggere volumi alti.

## Step 7.8 — File ed editor

Albero file e Monaco caricato on-demand, in **sola lettura per default**, con passaggio esplicito alla modifica manuale. È un'uscita di sicurezza, non il flusso principale: le modifiche manuali entrano nel diff di sessione marcate come umane.

## Step 7.9 — Command palette e notifiche

Palette minima per: navigazione tra pannelli, cambio modalità, apertura progetto, avvio e stop ambiente, avvio registrazione test, ricerca nel workspace. Notifiche non bloccanti per eventi lunghi (servizio pronto, test terminato, comando fallito) con link al pannello relativo, disattivabili.

## Step 7.10 — Comandi in linguaggio naturale

Ogni azione disponibile nei pannelli deve essere richiamabile anche come richiesta all'agent. Verificare con una checklist azione per azione: se qualcosa si può fare solo cliccando, manca un tool.

## Step 7.11 — Qualità della UI

- Tema scuro di default, chiaro e "segui sistema" disponibili; dimensione testo scalabile.
- Accessibilità di base: navigazione da tastiera completa, focus visibile, contrasto adeguato, etichette sugli elementi interattivi.
- Nessun blocco della UI durante l'esecuzione dei tool o lo streaming ad alto volume: liste virtualizzate, aggiornamenti in batch, lavoro pesante fuori dal thread di rendering.
- Impostazioni esposte in una schermata unica per sezioni, con i default del piano.

## Test richiesti

- End-to-end: turno completo con approvazione, ispezione del diff e ripristino di un checkpoint dalla sola UI.
- Carico: 100k righe di output in un pannello terminale senza degrado percepibile.
- Accessibilità: percorso completo del turno usando solo la tastiera.

## Criteri di uscita

- L'utente segue e controlla un turno intero senza strumenti esterni.
- Stato dell'agent sempre visibile e interrompibile; nessun output non troncato in conversazione.
- La checklist dello step 7.10 è completa.

## Rischi

- La conversazione degenera in un dump di log.
- UI originale poco usabile perché priva di riferimenti consolidati: iterare con uso reale prima della Fase 10.
