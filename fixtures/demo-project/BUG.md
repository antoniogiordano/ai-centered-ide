# Bug intenzionale (Fase 9–10)

**Non documentare questo bug nel codice.** Solo qui.

## Descrizione

La creazione di un item accetta titoli vuoti (solo spazi): la validazione lato API controlla `!title` ma non fa `trim()`, quindi `"   "` passa e viene salvato. Il frontend mostra una riga vuota nella lista.

## Come riprodurre

1. Login come `demo@example.com` / `password`
2. Nella lista, inserire tre spazi nel campo titolo e cliccare Add
3. Compare un item senza testo visibile

## Fix atteso

Rifiutare titoli con `title.trim().length === 0` (API + eventuale validazione UI) e aggiungere asserzione Cypress che uno spazio-only non crea item.
