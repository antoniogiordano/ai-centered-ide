# Fase 10 — Hardening, vertical slice e beta

**Obiettivo:** il prodotto regge l'uso quotidiano e dimostra il flusso end-to-end.
**Dipendenze:** Fase 9.

## Step 10.1 — Copertura del threat model

Un test per ogni minaccia, con esito atteso:

| Minaccia | Verifica |
| --- | --- |
| Injection dal repository | Un file con istruzioni ostili non altera policy né permessi |
| Injection dalla pagina in QA | Contenuto trattato come dato, nessuna elevazione |
| Esfiltrazione di segreti | Nessun valore in contesto, log, artefatti o export |
| Comando distruttivo | Denylist e conferma anche in Autonomous |
| Fuga dal workspace | Percorsi relativi, symlink e comandi fuori perimetro respinti |
| Escalation dal renderer | Nessuna API di sistema raggiungibile dal renderer |
| Contenuto remoto nell'IDE | La finestra principale carica solo risorse locali |
| Endpoint non fidato | HTTPS per host non locali, key solo all'host configurato |

## Step 10.2 — Errori e stati di fallimento

Percorrere ogni errore noto (provider giù, Docker assente, porta occupata, keychain bloccato, test in timeout, disco pieno) garantendo messaggio comprensibile, azione suggerita e UI mai indeterminata.

## Step 10.3 — Crash recovery

Alla riapertura dopo una chiusura brutale: ripristino di sessione e conversazione, segnalazione dei processi rimasti attivi con proposta di chiuderli, recupero dei checkpoint, nessun dato corrotto.

## Step 10.4 — Prestazioni

Obiettivi su demo e repository grande: finestra interattiva sotto 3 secondi; primo token entro 2 secondi dalla risposta del provider; ricerca sotto 1 secondo; UI mai bloccata; memoria a riposo stabile. Test di carico: output altissimo, sessione lunga con sintesi, repository grande.

## Step 10.5 — Osservabilità

- Log applicativi con livelli, rotazione e redazione; debug attivabile.
- **Timeline della sessione**: tracciato leggibile di messaggi, tool, approvazioni, modifiche ai file, avvii di servizi ed esecuzioni di test.
- Metriche locali: durata dei turni, tool eseguiti, fallimenti dei comandi, tempo di avvio dei servizi, stabilità dei test.
- **Export diagnostico** manuale con redazione, per condividere un problema senza perdere segreti.

## Step 10.6 — Rifinitura UI

Densità, stati vuoti, stati di errore, accessibilità. Chiusura definitiva di **Q7**.

## Step 10.7 — Vertical slice

Scenario di accettazione, sul demo e su ciascun OS, senza interventi manuali oltre a quelli descritti:

1. Primo avvio: Base URL, API key, verifica connessione, scelta del modello.
2. Apertura del demo: l'agent rileva l'assenza del manifest, lo propone completo, l'utente approva il diff.
3. Avvio ambiente: servizi nell'ordine corretto, healthcheck passati, stato con porte e URL.
4. Variabile mancante: l'agent verifica il gitignore, la aggiunge, riavvia **solo** il servizio interessato; la UI mostra chiave e scope, mai il valore.
5. Modifica funzionale: l'agent pianifica, modifica i file, ricarica il servizio; il diff mostra le modifiche per file.
6. Verifica visuale nel browser QA sul flusso modificato.
7. Registrazione: flusso completo più un'asserzione esplicita, test generato come modifica da approvare.
8. Rifinitura: l'agent sistema il test, aggiorna il seed e lo collega al manifest.
9. Esecuzione: due esecuzioni verdi con seed automatico.
10. Diagnosi: introdotta una regressione, l'agent riceve il pacchetto diagnostico, trova la causa e propone la correzione; dopo l'approvazione il test torna verde.
11. Checkpoint: ripristino di un checkpoint intermedio, con evento in conversazione.
12. Chiusura del lavoro: revisione del diff, stage, commit **confermato dall'umano**.
13. Chiusura dell'app: nessun processo attivo; alla riapertura sessione e stato ripristinati.

Verifiche trasversali: zero segreti in log, conversazioni, artefatti ed export; zero scritture fuori dal workspace; ogni azione dell'agent nell'audit; nessuna rete oltre al provider e ai target QA.

## Step 10.8 — Build interne

Build riproducibili dalla CI per i tre OS, moduli nativi (PTY, keychain) compilati per piattaforma con processo documentato. Nessuna firma né auto-update, ma senza precluderli. Versionamento interno, changelog, documentazione essenziale. Chiusura di **Q10**.

## Step 10.9 — Beta interna

Uso quotidiano su almeno tre progetti reali diversi dal demo, raccolta strutturata degli attriti, correzioni prioritarie, valutazione del backlog.

## Criteri di uscita

| Metrica | Obiettivo |
| --- | --- |
| Vertical slice | 100% dei passi sui tre OS |
| Interventi manuali fuori flusso | Zero |
| Stabilità dei test generati | Due esecuzioni verdi senza ritocchi |
| Fughe di segreti | Zero |
| Scritture fuori dal workspace | Zero |
| Processi orfani dopo la chiusura | Zero |
| Da progetto nuovo ad ambiente avviato | Sotto 10 minuti |

Nessun difetto bloccante o critico aperto. Il proprietario usa l'IDE come strumento principale su un progetto reale.

## Rischi

- Rientro del debito tecnico accumulato; attriti di UX scoperti tardi.
