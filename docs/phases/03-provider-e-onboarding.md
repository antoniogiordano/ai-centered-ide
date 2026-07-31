# Fase 3 — Provider AI e onboarding

**Obiettivo:** l'app parla con un endpoint OpenAI-compatible e la prima esperienza è completa.
**Dipendenze:** Fase 2. **Pacchetti:** `packages/provider`, `apps/renderer`, `packages/storage`.

## Step 3.1 — Astrazione del provider

Definire un'interfaccia unica con quattro capacità: elencare i modelli, inviare una conversazione con eventuale elenco di tool, ricevere la risposta in streaming, annullare la richiesta in corso. L'interfaccia non espone dettagli HTTP: chi la usa non sa se dietro c'è un endpoint reale o un mock.

Normalizzare in tipi propri messaggi, richieste di tool, risultati dei tool e informazioni di utilizzo token, così che il runtime della Fase 6 non dipenda dal formato del provider.

## Step 3.2 — Client OpenAI-compatible

- Chiamata di completamento chat con Base URL configurabile, API key nell'header, header aggiuntivi opzionali per proxy aziendali.
- Streaming incrementale con assemblaggio delle richieste di tool frammentate su più chunk.
- Endpoint dei modelli per popolare l'elenco; se non risponde, inserimento manuale del nome del modello.
- Annullamento che chiude davvero la connessione, senza lasciare richieste appese.
- Fallback non-streaming per provider che non lo supportano, attivabile dalle impostazioni.

## Step 3.3 — Errori, timeout, retry

- Timeout di richiesta con default 120 secondi, configurabile.
- Massimo 2 tentativi con backoff, solo su errori ritentabili (rete, 429, 5xx). Mai su 4xx di validazione o autenticazione.
- Mappatura degli errori in categorie con messaggio comprensibile: endpoint irraggiungibile, credenziale rifiutata, modello inesistente, limite di rate, risposta non conforme, timeout. Ogni categoria suggerisce l'azione correttiva.
- L'API key non compare mai in log, messaggi di errore o export diagnostici.

## Step 3.4 — Provider mock

Implementazione della stessa interfaccia guidata da scenari dichiarativi: sequenze di risposte e di richieste di tool, ritardi, errori iniettati, risposte non conformi, stream troncati. È la base di tutti i test di integrazione delle fasi successive e deve essere deterministico e senza rete.

## Step 3.5 — Onboarding

Schermata di primo avvio in quattro passi, con stato salvato per riprendere se interrotta:

1. inserimento della Base URL, con validazione del formato;
2. inserimento dell'API key, salvata nel keychain;
3. **verifica di connessione immediata** che chiama l'endpoint dei modelli e mostra esito, latenza e diagnostica leggibile in caso di errore;
4. selezione del modello dall'elenco recuperato, con ricerca e fallback manuale.

Al termine il cockpit si apre e la configurazione è modificabile dalle impostazioni.

## Step 3.6 — Impostazioni del provider

| Impostazione | Default |
| --- | --- |
| API key | vuota, nel keychain |
| Modello | primo dell'elenco remoto |
| Header aggiuntivi | nessuno |
| Timeout richiesta | 120 secondi |
| Tentativi | 2 con backoff |
| Streaming | attivo |

Le impostazioni rispettano i tre livelli di configurazione della Fase 2; le credenziali restano solo nel keychain.

## Step 3.7 — Sicurezza dell'endpoint

- Solo HTTPS per host non locali; HTTP consentito solo verso host locali e con avviso esplicito.
- La key viene inviata **solo** all'host configurato: un cambio di Base URL richiede riconferma.
- Nessuna chiamata di rete verso host diversi dal provider configurato.

## Test richiesti

- Unit: parsing dello stream, assemblaggio delle richieste di tool frammentate, classificazione degli errori, politica di retry.
- Integration: onboarding completo contro il mock; endpoint irraggiungibile e credenziale errata producono messaggi corretti; annullamento a metà stream non lascia richieste attive.
- Sicurezza: tentativo di configurare un endpoint remoto in HTTP viene rifiutato; la key non appare in nessun log.

## Criteri di uscita

- Un utente al primo avvio configura Base URL e key, verifica la connessione e sceglie un modello senza toccare file di configurazione.
- Streaming funzionante e fallback non-streaming corretto.
- Tutti i test di integrazione girano sul mock, senza rete e senza costi.

## Rischi

- Variabilità dei provider OpenAI-compatible su formato dei tool e streaming.
- Errori di rete poco diagnosticabili che l'utente non riesce a interpretare.
