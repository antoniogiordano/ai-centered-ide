# Fase 6 — Runtime agent

**Obiettivo:** l'agent porta a termine task reali sul codice, con controllo umano.
**Dipendenze:** Fase 3 e Fase 5. **Pacchetti:** `packages/agent`.

## Step 6.1 — Ciclo del turno

Un turno parte da un messaggio utente e procede così: costruzione del contesto, chiamata al provider, e se arriva una richiesta di tool si valuta la policy, si esegue o si chiede approvazione, si osserva il risultato e si torna al provider. Il turno termina quando il modello risponde senza richiedere tool, quando l'utente interrompe, o quando scatta un limite.

Il turno è una macchina a stati esplicita e ispezionabile, non un ciclo implicito: ogni transizione è registrata nello stato di sessione.

## Step 6.2 — Streaming e interruzione

- Il testo arriva incrementale alla UI, con primo token entro 2 secondi dalla risposta del provider.
- L'interruzione è sempre disponibile: annulla la richiesta al provider, ferma i tool in corso quando sono interrompibili, e lascia la sessione in uno stato coerente e ripartibile.
- Il lavoro già svolto non viene annullato in silenzio: le modifiche restano visibili nel diff e i checkpoint restano ripristinabili.

## Step 6.3 — Esecuzione dei tool

- Sequenziale per default. Il parallelismo è consentito solo a tool di **sola lettura**, con limite di concorrenza.
- Ogni risultato è normalizzato in un'osservazione: esito, sintesi breve, riferimento all'artefatto completo, metadati (durata, exit code, file toccati).
- Un tool fallito produce un'osservazione di errore su cui il modello può ragionare: non termina la conversazione.
- Gli output lunghi non entrano mai integralmente nel contesto: entra la sintesi, il resto è recuperabile con un tool di lettura mirata.

## Step 6.4 — Costruzione del contesto

Fonti in ordine di priorità:

1. istruzioni di sistema del prodotto e modalità corrente;
2. regole di progetto definite dall'utente in un file versionato nel repository;
3. manifest degli ambienti e stato corrente dei servizi (dalla Fase 8);
4. stato Git: branch, file modificati, diff sintetico della sessione;
5. cronologia della conversazione, con sintesi progressiva dei turni vecchi;
6. risultati recenti dei tool;
7. contenuti di file, solo su richiesta esplicita dell'agent, mai precaricati in massa.

Le modalità cambiano le istruzioni di sistema: in Ask e Plan il modello sa di non poter scrivere e deve proporre, non agire.

## Step 6.5 — Budget di contesto e sintesi

- Soglia di default al 70% della finestra del modello; oltre la soglia scatta la sintesi dei turni più vecchi.
- La sintesi conserva decisioni prese, file toccati, vincoli emersi e questioni aperte; scarta output verbosi già archiviati.
- I riferimenti ai file sostituiscono i contenuti integrali quando il file è già stato letto e non è cambiato.
- Stima dei token prima dell'invio, con troncamento controllato e visibile invece di un errore del provider.

## Step 6.6 — Limiti e interruzione automatica

- Massimo 25 iterazioni per turno, configurabile: al raggiungimento si chiede all'utente se continuare.
- Interruzione dopo 3 fallimenti consecutivi dello stesso tool, con spiegazione del motivo.
- Rilevamento dei loop: stessa chiamata con gli stessi argomenti ripetuta senza cambiamento di stato.
- Ogni limite raggiunto è un evento visibile in conversazione, mai un blocco silenzioso.

## Step 6.7 — Piano attivo

Struttura dati con passi, stato per passo (da fare, in corso, fatto, fallito, saltato) e collegamento alle azioni eseguite. In modalità Plan il piano è il deliverable del turno. In Agent e Autonomous il piano si aggiorna man mano ed è la spina dorsale della UI della Fase 7.

## Step 6.8 — Tracciabilità

Per ogni turno deve essere ricostruibile la sequenza completa: prompt di sistema usato, tool chiamati con argomenti, decisioni di policy, osservazioni, sintesi applicate. La traccia alimenta la timeline della Fase 10.

## Test richiesti

Tutti contro il provider mock della Fase 3:

- sequenza di più tool fino alla risposta finale;
- errore di tool seguito da recupero del modello;
- timeout di un tool e interruzione utente a metà stream;
- limite di iterazioni e loop-breaker che scattano;
- sessione lunga che attraversa la soglia di contesto, con sintesi applicata e memoria stabile;
- rifiuto di approvazione che rientra come osservazione.

## Criteri di uscita

- L'agent completa un task reale su un repository vero: esplora, pianifica, modifica file, esegue comandi e riporta il risultato.
- Per ogni turno la traccia è completa e ispezionabile.
- Una sessione lunga resta utilizzabile con la sintesi attiva.

## Rischi

- Gestione del contesto inadeguata sulle sessioni lunghe.
- Loop di tool improduttivi che bruciano budget senza avanzare.
