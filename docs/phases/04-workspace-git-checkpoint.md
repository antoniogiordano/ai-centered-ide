# Fase 4 — Workspace, Git e checkpoint

**Obiettivo:** accesso al progetto sicuro, ispezionabile e reversibile.
**Dipendenze:** Fase 2. **Pacchetti:** `packages/workspace`.

## Step 4.1 — Guardia del perimetro

Funzione unica attraversata da **ogni** operazione su file, prima di toccare il disco:

- normalizzazione del percorso e risoluzione in percorso assoluto reale, symlink inclusi;
- confronto con il percorso reale del workspace calcolato in Fase 2, con controllo per segmenti e non per prefisso di stringa;
- rifiuto di attraversamenti, percorsi UNC, unità diverse su Windows, e symlink che escono dal perimetro;
- gestione esplicita dei filesystem case-insensitive;
- errore tipizzato che indica il percorso rifiutato e il motivo, senza rivelare contenuti esterni.

**Fatto quando:** una suite di casi ostili (`..`, symlink, junction, percorsi assoluti, caratteri speciali) viene respinta al 100%.

## Step 4.2 — Servizio filesystem

- Lettura di un file o di un intervallo di righe, con rilevamento di file binari e limite di dimensione.
- Elenco directory con metadati leggeri; scrittura, creazione, modifica mirata di porzioni, eliminazione.
- Ogni scrittura passa dal checkpoint dello step 4.6 e produce un diff.
- Archivio degli artefatti su disco per gli output lunghi, con identificatore stabile, rotazione e limiti di dimensione: i tool restituiranno una sintesi più il riferimento.

## Step 4.3 — Ricerca

- Ricerca testuale e per pattern su tutto il workspace, con rispetto di `.gitignore`, filtri per glob e tipo di file, limite di risultati e contesto per riga.
- Ricerca file per nome o glob.
- Esecuzione fuori dal thread principale, annullabile, con obiettivo di **meno di 1 secondo** su repository medio.

## Step 4.4 — Mappa strutturale

Sintesi del progetto ricalcolata su richiesta: albero directory con profondità limitata, file chiave, linguaggi prevalenti, gestori di pacchetti, script disponibili, presenza di Docker e di test. Nessun embedding, nessun database vettoriale.

## Step 4.5 — Servizio Git

- Stato: branch, file modificati, staged, untracked, presenza di conflitti.
- Diff per file, diff complessivo e **diff di sessione**, che distingue le modifiche prodotte dall'agent da quelle manuali dell'utente registrando l'origine di ogni scrittura.
- Stage, unstage, commit con messaggio, creazione e cambio branch.
- Operazioni che scartano lavoro o riscrivono la storia sono marcate distruttive e saranno esposte solo con conferma in Fase 5. Nessun commit automatico, nessun push disponibile all'agent.

## Step 4.6 — Checkpoint

- Snapshot locale creato prima di ogni gruppo di modifiche significativo: inizio di un turno che scrive file, azione sensibile, seed distruttivo.
- Registra i file toccati e il loro contenuto precedente; il ripristino riporta il workspace allo stato esatto e genera un evento tracciabile.
- **Fuori dalla storia Git**: nessun commit, nessun branch, nessuna traccia nel repository dell'utente.
- **Mai includere file ignorati che contengono segreti**: la lista di esclusione è esplicita e testata.
- Retention configurabile con default sulle sessioni recenti, pulizia manuale, indice consultabile con data, motivo e file coinvolti.

## Test richiesti

- Unit: guardia del perimetro sui casi ostili dei tre OS; calcolo del diff di sessione con modifiche concorrenti dell'utente.
- Integration: scrittura, checkpoint, ripristino e verifica byte a byte del contenuto precedente; ricerca su un repository grande entro il limite di tempo; un file `.env` ignorato non entra mai in un checkpoint.

## Punti da chiudere

- **Q4** — meccanismo esatto dei checkpoint (copia dei file toccati o repository ombra) e politica di retention, con costi misurati su un repository grande.

## Criteri di uscita

- Nessuna scrittura possibile fuori dal workspace, dimostrato dai test.
- Un checkpoint si crea e si ripristina correttamente, con evento registrato.
- Il diff di sessione resta corretto in presenza di modifiche manuali.
- La ricerca rispetta l'obiettivo di prestazione e non blocca la UI.

## Rischi

- Case sensitivity e forme dei percorsi diverse tra i tre sistemi operativi.
- Checkpoint costosi su repository grandi: misurare prima di scegliere il meccanismo.
